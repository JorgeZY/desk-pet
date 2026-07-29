import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { ModelDownloadProgress, ModelDownloadSource } from "../shared/types";

export const MANAGED_MODEL = {
  id: "openbmb/MiniCPM5-1B-GGUF:Q4_K_M",
  filename: "MiniCPM5-1B-Q4_K_M.gguf",
  minimumBytes: 600_000_000,
} as const;

interface ModelSource {
  id: ModelDownloadSource;
  label: string;
  url: string;
}

const MODEL_SOURCES: readonly ModelSource[] = [
  {
    id: "modelscope",
    label: "ModelScope",
    url: `https://www.modelscope.cn/models/OpenBMB/MiniCPM5-1B-GGUF/resolve/master/${MANAGED_MODEL.filename}`,
  },
  {
    id: "huggingface",
    label: "Hugging Face",
    url: `https://huggingface.co/openbmb/MiniCPM5-1B-GGUF/resolve/main/${MANAGED_MODEL.filename}?download=true`,
  },
];

export type ModelFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ResolveModelOptions {
  signal: AbortSignal;
  onProgress: (progress: ModelDownloadProgress) => void;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function parseTotalBytes(response: Response, resumedAt: number): number | undefined {
  const contentRange = response.headers.get("content-range");
  const rangeMatch = contentRange?.match(/\/(\d+)$/);
  if (rangeMatch) return Number(rangeMatch[1]);

  const contentLength = Number(response.headers.get("content-length"));
  if (!Number.isFinite(contentLength) || contentLength <= 0) return undefined;
  return contentLength + (response.status === 206 ? resumedAt : 0);
}

function linkedController(parent: AbortSignal): {
  controller: AbortController;
  dispose: () => void;
} {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (parent.aborted) controller.abort();
  else parent.addEventListener("abort", onParentAbort, { once: true });
  return {
    controller,
    dispose: () => parent.removeEventListener("abort", onParentAbort),
  };
}

function waitWithTimeout<T>(
  operation: Promise<T>,
  controller: AbortController,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () =>
      finish(() => reject(new DOMException("下载已取消", "AbortError")));
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`连接或传输在 ${Math.round(timeoutMs / 1000)} 秒内无响应`)));
      controller.abort();
    }, timeoutMs);

    if (controller.signal.aborted) {
      onAbort();
      return;
    }
    controller.signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

export class ManagedModelDownloader {
  constructor(
    private readonly modelDirectory: string,
    private readonly fetchModel: ModelFetch,
    private readonly minimumBytes = MANAGED_MODEL.minimumBytes,
    private readonly inactivityTimeoutMs = 45_000,
  ) {}

  async resolve(modelId: string, options: ResolveModelOptions): Promise<string | null> {
    if (modelId.trim().toLowerCase() !== MANAGED_MODEL.id.toLowerCase()) {
      return null;
    }

    await fs.mkdir(this.modelDirectory, { recursive: true });
    const targetPath = join(this.modelDirectory, MANAGED_MODEL.filename);
    const partialPath = `${targetPath}.part`;
    const targetSize = await this.fileSize(targetPath);

    if (targetSize >= this.minimumBytes) return targetPath;
    if (targetSize > 0) {
      if ((await this.fileSize(partialPath)) === 0) await fs.rename(targetPath, partialPath);
      else await fs.rm(targetPath, { force: true });
    }

    const failures: string[] = [];
    for (const source of MODEL_SOURCES) {
      if (options.signal.aborted) throw new DOMException("下载已取消", "AbortError");
      try {
        await this.downloadFromSource(source, partialPath, options);
        const finalSize = await this.fileSize(partialPath);
        if (finalSize < this.minimumBytes) {
          throw new Error(`文件不完整，仅收到 ${formatBytes(finalSize)}`);
        }
        await fs.rename(partialPath, targetPath);
        return targetPath;
      } catch (error) {
        if (options.signal.aborted) throw new DOMException("下载已取消", "AbortError");
        failures.push(`${source.label}：${errorMessage(error)}`);
      }
    }

    throw new Error(
      `自动下载失败。${failures.join("；")}。可在设置中切换到“本地 GGUF”并手动选择模型文件。`,
    );
  }

  private async downloadFromSource(
    source: ModelSource,
    partialPath: string,
    options: ResolveModelOptions,
    restarted = false,
  ): Promise<void> {
    const partialSize = await this.fileSize(partialPath);
    const headers = new Headers({ accept: "application/octet-stream,*/*" });
    if (partialSize > 0) headers.set("range", `bytes=${partialSize}-`);

    const attempt = linkedController(options.signal);
    let response: Response;
    try {
      response = await waitWithTimeout(
        this.fetchModel(source.url, {
          headers,
          redirect: "follow",
          signal: attempt.controller.signal,
        }),
        attempt.controller,
        this.inactivityTimeoutMs,
      );

      if (response.status === 416 && partialSize > 0 && !restarted) {
        attempt.dispose();
        await fs.truncate(partialPath, 0);
        return this.downloadFromSource(source, partialPath, options, true);
      }

      if (!response.ok) {
        const detail = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 240);
        throw new Error(`HTTP ${response.status}${detail ? `：${detail}` : ""}`);
      }
      if (!response.body) throw new Error("服务器没有返回模型数据");

      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType.includes("text/html") || contentType.includes("application/json")) {
        throw new Error(`服务器返回了 ${contentType || "非模型内容"}`);
      }

      const append = partialSize > 0 && response.status === 206;
      const receivedAtStart = append ? partialSize : 0;
      const totalBytes = parseTotalBytes(response, receivedAtStart);
      const file = await fs.open(partialPath, append ? "a" : "w");
      const reader = response.body.getReader();
      let receivedBytes = receivedAtStart;
      let lastReportedAt = 0;

      const report = (force = false): void => {
        const now = Date.now();
        if (!force && now - lastReportedAt < 250) return;
        lastReportedAt = now;
        options.onProgress({
          source: source.id,
          receivedBytes,
          totalBytes,
          percent: totalBytes
            ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100))
            : undefined,
        });
      };

      try {
        report(true);
        while (true) {
          const chunk = await waitWithTimeout(
            reader.read(),
            attempt.controller,
            this.inactivityTimeoutMs,
          );
          if (chunk.done) break;
          await file.write(chunk.value);
          receivedBytes += chunk.value.byteLength;
          report();
        }
        report(true);
      } finally {
        await file.close();
      }

      if (totalBytes && receivedBytes !== totalBytes) {
        throw new Error(`下载中断：${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)}`);
      }
    } finally {
      attempt.dispose();
    }
  }

  private async fileSize(path: string): Promise<number> {
    try {
      return (await fs.stat(path)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }
}
