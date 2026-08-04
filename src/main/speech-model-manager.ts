import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
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

export interface DiscoveredSpeechModels {
  streaming: { encoder: string; decoder: string; tokens: string };
  final: { model: string; tokens: string };
}

interface ScannedDirectory {
  directory: string;
  files: string[];
}

function modelScore(path: string, role: "encoder" | "decoder" | "final"): number {
  const name = basename(path).toLowerCase();
  let score = name.includes("int8") ? 100 : 0;
  if (role === "final") {
    if (name.includes("sensevoice") || name.includes("sense-voice")) score += 80;
    if (name === "model.int8.onnx") score += 60;
    else if (name === "model.onnx") score += 40;
  } else if (name === `${role}.int8.onnx`) {
    score += 60;
  } else if (name === `${role}.onnx`) {
    score += 40;
  }
  return score;
}

function bestFile(files: string[], role: "encoder" | "decoder" | "final"): string | undefined {
  const candidates = files.filter((path) => {
    const name = basename(path).toLowerCase();
    if (!name.endsWith(".onnx")) return false;
    if (role === "final") return !name.includes("encoder") && !name.includes("decoder");
    return name.includes(role);
  });
  return candidates.sort((left, right) =>
    modelScore(right, role) - modelScore(left, role) || left.localeCompare(right),
  )[0];
}

function tokenFile(files: string[]): string | undefined {
  return files
    .filter((path) => /^tokens?.*\.txt$/iu.test(basename(path)))
    .sort((left, right) => {
      const leftExact = basename(left).toLowerCase() === "tokens.txt" ? 1 : 0;
      const rightExact = basename(right).toLowerCase() === "tokens.txt" ? 1 : 0;
      return rightExact - leftExact || left.localeCompare(right);
    })[0];
}

async function scanDirectories(root: string): Promise<ScannedDirectory[]> {
  const stat = await fs.stat(root).catch(() => undefined);
  if (!stat?.isDirectory()) throw new Error(`导入目录不存在或不是文件夹：${root}`);
  const found = new Map<string, string[]>();
  let visited = 0;

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 12) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (++visited > 20_000) throw new Error("导入目录文件过多，请选择更靠近语音模型的文件夹。");
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path, depth + 1);
      } else if (entry.isFile() && (/\.onnx$/iu.test(entry.name) || /^tokens?.*\.txt$/iu.test(entry.name))) {
        const files = found.get(directory) ?? [];
        files.push(path);
        found.set(directory, files);
      }
    }
  };

  await walk(root, 0);
  return [...found].map(([directory, files]) => ({ directory, files }));
}

export async function discoverSpeechModels(root: string): Promise<DiscoveredSpeechModels> {
  const directories = await scanDirectories(root);
  const streaming = directories
    .map(({ directory, files }) => ({
      directory,
      encoder: bestFile(files, "encoder"),
      decoder: bestFile(files, "decoder"),
      tokens: tokenFile(files),
    }))
    .filter((value) => value.encoder && value.decoder && value.tokens)
    .sort((left, right) => {
      const leftScore = modelScore(left.encoder!, "encoder") + modelScore(left.decoder!, "decoder");
      const rightScore = modelScore(right.encoder!, "encoder") + modelScore(right.decoder!, "decoder");
      return rightScore - leftScore || left.directory.localeCompare(right.directory);
    })[0];
  const final = directories
    .map(({ directory, files }) => ({
      directory,
      model: bestFile(files, "final"),
      tokens: tokenFile(files),
    }))
    .filter((value) => value.model && value.tokens && value.directory !== streaming?.directory)
    .sort((left, right) =>
      modelScore(right.model!, "final") - modelScore(left.model!, "final") ||
      left.directory.localeCompare(right.directory),
    )[0];

  const missing: string[] = [];
  if (!streaming) missing.push("Paraformer encoder/decoder/tokens");
  if (!final) missing.push("SenseVoice model/tokens");
  if (missing.length) {
    throw new Error(`没有在所选目录中找到完整的 ${missing.join(" 和 ")}。`);
  }
  return {
    streaming: {
      encoder: streaming.encoder!,
      decoder: streaming.decoder!,
      tokens: streaming.tokens!,
    },
    final: { model: final.model!, tokens: final.tokens! },
  };
}

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

function pathsFromDiscovery(root: string, discovered: DiscoveredSpeechModels): SpeechModelPaths {
  return {
    root,
    streaming: {
      directory: dirname(discovered.streaming.encoder),
      ...discovered.streaming,
    },
    final: {
      directory: dirname(discovered.final.model),
      ...discovered.final,
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
  private readonly managedPaths: SpeechModelPaths;
  private activePaths: SpeechModelPaths;
  private ready = false;

  constructor(
    private readonly modelDirectory: string,
    private readonly scriptDirectory: string,
    private readonly runScript: SpeechScriptRunner = runSpeechDownloadScript,
    private importedDirectory = "",
  ) {
    this.managedPaths = resolveSpeechModelPaths(modelDirectory);
    this.activePaths = this.managedPaths;
  }

  get paths(): SpeechModelPaths {
    return this.activePaths;
  }

  get displayedDirectory(): string {
    return this.importedDirectory || this.managedPaths.root;
  }

  setImportedDirectory(directory: string): void {
    const nextDirectory = directory.trim();
    if (nextDirectory === this.importedDirectory) return;
    this.importedDirectory = nextDirectory;
    this.ready = false;
    if (!this.importedDirectory) this.activePaths = this.managedPaths;
  }

  useManagedModels(): void {
    this.importedDirectory = "";
    this.activePaths = this.managedPaths;
    this.ready = false;
  }

  async isReady(): Promise<boolean> {
    if (this.ready) return true;
    if (this.importedDirectory) {
      try {
        this.activePaths = pathsFromDiscovery(
          this.importedDirectory,
          await discoverSpeechModels(this.importedDirectory),
        );
        this.ready = true;
        return this.ready;
      } catch {
        return false;
      }
    }
    const streamingReady = await hasRequiredFiles(
      this.managedPaths.streaming.directory,
      SPEECH_MODELS[0].requiredFiles,
    );
    if (streamingReady) {
      await Promise.all(
        UNUSED_STREAMING_FP32_FILES.map((file) =>
          fs.rm(join(this.managedPaths.streaming.directory, file), { force: true }),
        ),
      );
    }
    this.ready = streamingReady &&
      (await hasRequiredFiles(this.managedPaths.final.directory, SPEECH_MODELS[1].requiredFiles));
    return this.ready;
  }

  async importFromDirectory(sourceDirectory: string): Promise<SpeechModelPaths> {
    const discovered = await discoverSpeechModels(sourceDirectory);
    this.importedDirectory = sourceDirectory;
    this.activePaths = pathsFromDiscovery(sourceDirectory, discovered);
    this.ready = true;
    return this.activePaths;
  }

  async prepare(
    signal: AbortSignal,
    onProgress: (progress: SpeechDownloadProgress) => void,
    force = false,
  ): Promise<SpeechModelPaths> {
    this.useManagedModels();
    await writableDirectory(this.modelDirectory);
    for (const spec of SPEECH_MODELS) {
      const target = join(this.managedPaths.root, spec.directory);
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
    return this.managedPaths;
  }
}
