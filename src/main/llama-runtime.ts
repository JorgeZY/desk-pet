import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, win32 } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  ChatEvent,
  ChatRequest,
  ModelDownloadProgress,
  RuntimeConfig,
  RuntimeState,
} from "../shared/types";
import { formatBytes, type ResolveModelOptions } from "./model-downloader";
import { SseDecoder } from "./sse";

const MODEL_ALIAS = "desk-pet-model";

export interface LlamaCommand {
  command: string;
  args: string[];
}

export type ManagedModelResolver = (
  modelId: string,
  options: ResolveModelOptions,
) => Promise<string | null>;

export function buildLlamaCommand(config: RuntimeConfig): LlamaCommand {
  const executable = config.executable.trim();
  const fileName = win32.basename(executable).toLowerCase() || basename(executable).toLowerCase();
  const args: string[] = fileName === "llama" || fileName === "llama.exe" ? ["serve"] : [];

  if (config.modelMode === "huggingface") {
    args.push("-hf", config.hfRepo);
  } else {
    args.push("-m", config.modelPath);
  }

  args.push(
    "--host",
    config.host,
    "--port",
    String(config.port),
    "-c",
    String(config.contextSize),
    "-ngl",
    String(config.gpuLayers),
    "-t",
    String(config.threads),
    "-np",
    "1",
    "--alias",
    MODEL_ALIAS,
    "--jinja",
    "--cors-origins",
    "localhost",
  );

  return { command: executable, args };
}

const initialState = (config: RuntimeConfig): RuntimeState => ({
  phase: "stopped",
  endpoint: `http://${config.host}:${config.port}`,
  message: "本地模型尚未启动",
  updatedAt: Date.now(),
});

export class LlamaRuntime extends EventEmitter {
  private config: RuntimeConfig;
  private child: ChildProcessWithoutNullStreams | null = null;
  private state: RuntimeState;
  private generation = 0;
  private downloadController: AbortController | null = null;
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(
    config: RuntimeConfig,
    private readonly resolveManagedModel?: ManagedModelResolver,
  ) {
    super();
    this.config = config;
    this.state = initialState(config);
  }

  updateConfig(config: RuntimeConfig): void {
    this.config = config;
    if (this.state.phase === "stopped" || this.state.phase === "error") {
      this.setState({
        ...this.state,
        endpoint: this.endpoint,
        updatedAt: Date.now(),
      });
    }
  }

  get snapshot(): RuntimeState {
    return { ...this.state };
  }

  get endpoint(): string {
    return `http://${this.config.host}:${this.config.port}`;
  }

  async start(): Promise<RuntimeState> {
    if (this.state.phase === "ready" || this.state.phase === "starting" || this.state.phase === "downloading") {
      return this.snapshot;
    }

    if (
      this.config.modelMode === "local" &&
      (!this.config.modelPath || !existsSync(this.config.modelPath))
    ) {
      return this.fail("找不到本地 GGUF 模型，请在设置中重新选择模型文件。");
    }
    if (isAbsolute(this.config.executable) && !existsSync(this.config.executable)) {
      return this.fail("找不到 llama.cpp 可执行文件，请在设置中重新选择。");
    }

    if (await this.isHealthy(600)) {
      this.setState({
        phase: "ready",
        endpoint: this.endpoint,
        message: "已连接当前端口上的 llama.cpp 服务",
        externallyManaged: true,
        updatedAt: Date.now(),
      });
      return this.snapshot;
    }

    const currentGeneration = ++this.generation;
    const launchConfig = { ...this.config };

    if (launchConfig.modelMode === "huggingface" && this.resolveManagedModel) {
      this.downloadController = new AbortController();
      this.setState({
        phase: "downloading",
        endpoint: this.endpoint,
        message: "正在连接模型镜像",
        lastLog: "应用会优先使用 ModelScope，失败后自动切换 Hugging Face。",
        updatedAt: Date.now(),
      });
      void this.prepareManagedModel(
        launchConfig,
        currentGeneration,
        this.downloadController,
      );
      return this.snapshot;
    }

    this.launch(launchConfig, currentGeneration);

    return this.snapshot;
  }

  async stop(): Promise<RuntimeState> {
    this.generation += 1;
    this.downloadController?.abort();
    this.downloadController = null;
    for (const controller of this.abortControllers.values()) controller.abort();
    this.abortControllers.clear();

    if (!this.child) {
      this.setState(initialState(this.config));
      return this.snapshot;
    }

    const child = this.child;
    this.child = null;
    this.setState({
      ...this.state,
      phase: "stopping",
      message: "正在停止本地模型",
      updatedAt: Date.now(),
    });

    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.killed) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 2500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });

    this.setState(initialState(this.config));
    return this.snapshot;
  }

  async restart(): Promise<RuntimeState> {
    await this.stop();
    return this.start();
  }

  abortChat(requestId: string): void {
    this.abortControllers.get(requestId)?.abort();
  }

  async streamChat(request: ChatRequest, emit: (event: ChatEvent) => void): Promise<void> {
    if (this.state.phase !== "ready") throw new Error("本地模型尚未就绪。");

    const controller = new AbortController();
    this.abortControllers.set(request.requestId, controller);
    emit({ requestId: request.requestId, type: "start" });

    try {
      const response = await fetch(`${this.endpoint}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: MODEL_ALIAS,
          messages: [
            { role: "system", content: this.config.systemPrompt },
            ...request.messages.slice(-20).map((message) => ({
              role: message.role,
              content: message.content,
            })),
          ],
          stream: true,
          max_tokens: this.config.maxTokens,
          temperature: request.thinking ? 0.9 : this.config.temperature,
          top_p: 0.95,
          chat_template_kwargs: { enable_thinking: request.thinking },
        }),
      });

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 800);
        throw new Error(`llama.cpp 返回 ${response.status}：${detail || response.statusText}`);
      }
      if (!response.body) throw new Error("llama.cpp 没有返回可读取的数据流。");

      const reader = response.body.getReader();
      const textDecoder = new TextDecoder();
      const sse = new SseDecoder();
      let timings: Record<string, unknown> | undefined;

      const consume = (data: string): boolean => {
        if (data === "[DONE]") return true;
        const payload = JSON.parse(data) as {
          choices?: Array<{
            delta?: { content?: string; reasoning_content?: string };
          }>;
          timings?: Record<string, unknown>;
        };
        timings = payload.timings ?? timings;
        const delta = payload.choices?.[0]?.delta;
        if (delta?.reasoning_content) {
          emit({
            requestId: request.requestId,
            type: "reasoning",
            text: delta.reasoning_content,
          });
        }
        if (delta?.content) {
          emit({ requestId: request.requestId, type: "delta", text: delta.content });
        }
        return false;
      };

      let done = false;
      while (!done) {
        const part = await reader.read();
        if (part.done) break;
        for (const event of sse.push(textDecoder.decode(part.value, { stream: true }))) {
          done = consume(event.data);
          if (done) break;
        }
      }
      for (const event of sse.finish()) {
        if (!done) done = consume(event.data);
      }

      emit({ requestId: request.requestId, type: "done", timings });
    } catch (error) {
      const message =
        error instanceof Error && error.name === "AbortError"
          ? "已停止生成"
          : error instanceof Error
            ? error.message
            : String(error);
      emit({ requestId: request.requestId, type: "error", message });
    } finally {
      this.abortControllers.delete(request.requestId);
    }
  }

  private async waitUntilReady(generation: number): Promise<void> {
    const startedAt = Date.now();
    const timeoutMs = 30 * 60 * 1000;

    while (generation === this.generation && this.child && Date.now() - startedAt < timeoutMs) {
      if (await this.isHealthy(900)) {
        this.setState({
          ...this.state,
          phase: "ready",
          pid: this.child.pid,
          endpoint: this.endpoint,
          message: "本地模型已就绪",
          error: undefined,
          download: undefined,
          externallyManaged: false,
          updatedAt: Date.now(),
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (generation === this.generation && this.child) {
      this.fail("模型在 30 分钟内未能就绪，请检查网络、磁盘空间和运行日志。");
      this.child.kill();
      this.child = null;
    }
  }

  private async isHealthy(timeoutMs: number): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.endpoint}/health`, { signal: controller.signal });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private fail(message: string): RuntimeState {
    this.setState({
      ...this.state,
      phase: "error",
      endpoint: this.endpoint,
      message: "本地模型启动失败",
      error: message,
      download: undefined,
      updatedAt: Date.now(),
    });
    return this.snapshot;
  }

  private setState(state: RuntimeState): void {
    this.state = state;
    this.emit("state", this.snapshot);
  }

  private async prepareManagedModel(
    config: RuntimeConfig,
    generation: number,
    controller: AbortController,
  ): Promise<void> {
    try {
      const modelPath = await this.resolveManagedModel!(config.hfRepo, {
        signal: controller.signal,
        onProgress: (download) => this.updateDownloadState(generation, download),
      });
      if (generation !== this.generation || controller.signal.aborted) return;
      this.downloadController = null;
      this.launch(
        modelPath ? { ...config, modelMode: "local", modelPath } : config,
        generation,
      );
    } catch (error) {
      if (generation !== this.generation || controller.signal.aborted) return;
      this.downloadController = null;
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private updateDownloadState(
    generation: number,
    download: ModelDownloadProgress,
  ): void {
    if (generation !== this.generation) return;
    const source = download.source === "modelscope" ? "ModelScope" : "Hugging Face";
    const amount = download.totalBytes
      ? `${formatBytes(download.receivedBytes)} / ${formatBytes(download.totalBytes)}`
      : formatBytes(download.receivedBytes);
    this.setState({
      ...this.state,
      phase: "downloading",
      message:
        download.percent === undefined
          ? `正在从 ${source} 下载模型`
          : `正在从 ${source} 下载模型 · ${download.percent}%`,
      lastLog: amount,
      download,
      updatedAt: Date.now(),
    });
  }

  private launch(config: RuntimeConfig, generation: number): void {
    const { command, args } = buildLlamaCommand(config);
    this.setState({
      phase: "starting",
      endpoint: this.endpoint,
      message:
        config.modelMode === "huggingface"
          ? "正在启动 llama.cpp 并准备远程模型"
          : "正在加载本地 GGUF 模型",
      download: undefined,
      updatedAt: Date.now(),
    });

    try {
      const child = spawn(command, args, {
        cwd: isAbsolute(command) ? dirname(command) : undefined,
        env: { ...process.env },
        windowsHide: true,
        stdio: "pipe",
      });
      this.child = child;

      const handleLog = (buffer: Buffer): void => {
        const lines = buffer
          .toString("utf8")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        const lastLog = lines.at(-1);
        if (!lastLog) return;
        const looksLikeDownload =
          config.modelMode === "huggingface" &&
          /download|huggingface|\.gguf|%|MiB|GiB/i.test(lastLog);
        this.setState({
          ...this.state,
          phase: looksLikeDownload ? "downloading" : this.state.phase,
          message: looksLikeDownload
            ? "llama.cpp 正在下载远程 GGUF 模型"
            : this.state.message,
          lastLog: lastLog.slice(-500),
          updatedAt: Date.now(),
        });
      };

      child.stdout.on("data", handleLog);
      child.stderr.on("data", handleLog);
      child.once("error", (error) => {
        if (generation !== this.generation) return;
        this.child = null;
        this.fail(`无法启动 llama.cpp：${error.message}`);
      });
      child.once("exit", (code, signal) => {
        if (generation !== this.generation) return;
        this.child = null;
        if (this.state.phase === "stopping" || this.state.phase === "stopped") return;
        this.fail(
          `llama.cpp 已退出（${signal ? `信号 ${signal}` : `退出码 ${code ?? "未知"}`}）。`,
        );
      });

      void this.waitUntilReady(generation);
    } catch (error) {
      this.child = null;
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }
}
