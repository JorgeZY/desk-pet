import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { SpeechDownloadProgress, SpeechModelId } from "../shared/types";

interface SpeechModelSpec {
  id: SpeechModelId;
  directory: string;
  script: string;
  requiredFiles: readonly string[];
}

const SPEECH_MODELS: readonly SpeechModelSpec[] = [
  {
    id: "streaming-paraformer",
    directory: "streaming-paraformer-bilingual-zh-en",
    script: "download-streaming-model.ps1",
    requiredFiles: ["encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt"],
  },
  {
    id: "sense-voice",
    directory: "sense-voice-zh-en-ja-ko-yue-int8",
    script: "download-models.ps1",
    requiredFiles: ["model.int8.onnx", "tokens.txt"],
  },
] as const;

const UNUSED_STREAMING_FP32_FILES = ["encoder.onnx", "decoder.onnx"] as const;

export interface SpeechModelPaths {
  root: string;
  streaming: {
    directory: string;
    encoder: string;
    decoder: string;
    tokens: string;
  };
  final: {
    directory: string;
    model: string;
    tokens: string;
  };
}

export interface SpeechScriptInvocation {
  scriptPath: string;
  modelRoot: string;
  force: boolean;
  signal: AbortSignal;
}

export type SpeechScriptRunner = (invocation: SpeechScriptInvocation) => Promise<void>;

export function resolveSpeechModelPaths(modelDirectory: string): SpeechModelPaths {
  const root = join(modelDirectory, "speech");
  const streamingDirectory = join(root, SPEECH_MODELS[0].directory);
  const finalDirectory = join(root, SPEECH_MODELS[1].directory);
  return {
    root,
    streaming: {
      directory: streamingDirectory,
      encoder: join(streamingDirectory, "encoder.int8.onnx"),
      decoder: join(streamingDirectory, "decoder.int8.onnx"),
      tokens: join(streamingDirectory, "tokens.txt"),
    },
    final: {
      directory: finalDirectory,
      model: join(finalDirectory, "model.int8.onnx"),
      tokens: join(finalDirectory, "tokens.txt"),
    },
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function hasRequiredFiles(directory: string, files: readonly string[]): Promise<boolean> {
  return (await Promise.all(files.map((file) => pathExists(join(directory, file))))).every(Boolean);
}

async function writableDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  const probe = join(directory, `.write-probe-${process.pid}-${Date.now()}`);
  try {
    await fs.writeFile(probe, "ok", { flag: "wx" });
  } catch (error) {
    throw new Error(
      `模型目录不可写：${directory}。请把 desk-pet 放到有写入权限的目录后重试。`,
      { cause: error },
    );
  } finally {
    await fs.rm(probe, { force: true }).catch(() => undefined);
  }
}

export const runSpeechDownloadScript: SpeechScriptRunner = async ({
  scriptPath,
  modelRoot,
  force,
  signal,
}) => {
  await fs.access(scriptPath);
  const executable = process.platform === "win32" ? "powershell.exe" : "pwsh";
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-ModelRoot",
    modelRoot,
  ];
  if (force) args.push("-Force");

  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let stderr = "";
    child.stdout.on("data", (chunk) => process.stdout.write(`[speech-model] ${chunk}`));
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      process.stderr.write(`[speech-model] ${text}`);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `语音模型下载脚本退出，代码 ${code ?? "unknown"}。`));
    });
  });
};

export class SpeechModelManager {
  readonly paths: SpeechModelPaths;

  constructor(
    private readonly modelDirectory: string,
    private readonly scriptDirectory: string,
    private readonly runScript: SpeechScriptRunner = runSpeechDownloadScript,
  ) {
    this.paths = resolveSpeechModelPaths(modelDirectory);
  }

  async isReady(): Promise<boolean> {
    const streamingReady = await hasRequiredFiles(
      this.paths.streaming.directory,
      SPEECH_MODELS[0].requiredFiles,
    );
    if (streamingReady) {
      await Promise.all(
        UNUSED_STREAMING_FP32_FILES.map((file) =>
          fs.rm(join(this.paths.streaming.directory, file), { force: true }),
        ),
      );
    }
    return streamingReady &&
      (await hasRequiredFiles(this.paths.final.directory, SPEECH_MODELS[1].requiredFiles));
  }

  async prepare(
    signal: AbortSignal,
    onProgress: (progress: SpeechDownloadProgress) => void,
    force = false,
  ): Promise<SpeechModelPaths> {
    await writableDirectory(this.modelDirectory);
    for (const spec of SPEECH_MODELS) {
      const target = join(this.paths.root, spec.directory);
      if (!force && (await hasRequiredFiles(target, spec.requiredFiles))) continue;
      onProgress({ model: spec.id, receivedBytes: 0 });
      await this.runScript({
        scriptPath: join(this.scriptDirectory, spec.script),
        modelRoot: this.modelDirectory,
        force,
        signal,
      });
      if (!(await hasRequiredFiles(target, spec.requiredFiles))) {
        throw new Error(`${spec.id} 下载脚本完成，但模型文件不完整。`);
      }
      onProgress({ model: spec.id, receivedBytes: 1, totalBytes: 1, percent: 100 });
    }
    if (!(await this.isReady())) throw new Error("语音模型没有完整安装。请重新运行下载脚本。");
    return this.paths;
  }
}
