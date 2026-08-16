import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { TtsDownloadProgress } from "../shared/types";

const TTS_MODEL_DIRECTORY = "vits-melo-tts-zh_en";
const TTS_DATA_DIRECTORY = "espeak-ng-data";
const TTS_MODEL_SCRIPT = "download-tts-model.ps1";
const TTS_MODEL_FILES = ["model.onnx", "lexicon.txt", "tokens.txt"] as const;

export interface TtsModelPaths {
  root: string;
  directory: string;
  model: string;
  lexicon: string;
  tokens: string;
  /** espeak-ng data directory used to phonemize English words. */
  dataDir?: string;
}

export interface TtsScriptInvocation {
  scriptPath: string;
  modelRoot: string;
  force: boolean;
  signal: AbortSignal;
}

export type TtsScriptRunner = (invocation: TtsScriptInvocation) => Promise<void>;

interface ScannedDirectory {
  directory: string;
  files: string[];
}

function pathExists(path: string): Promise<boolean> {
  return fs.access(path).then(
    () => true,
    () => false,
  );
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
      if (++visited > 20_000) throw new Error("导入目录文件过多，请选择更靠近 TTS 模型的文件夹。");
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path, depth + 1);
      } else if (
        entry.isFile() &&
        (/\.onnx$/iu.test(entry.name) || /^lexicon.*\.txt$/iu.test(entry.name) || /^tokens?.*\.txt$/iu.test(entry.name))
      ) {
        const files = found.get(directory) ?? [];
        files.push(path);
        found.set(directory, files);
      }
    }
  };

  await walk(root, 0);
  return [...found].map(([directory, files]) => ({ directory, files }));
}

const EXPECTED_FILE_NAME: Record<"model" | "lexicon" | "tokens", string> = {
  model: "model.onnx",
  lexicon: "lexicon.txt",
  tokens: "tokens.txt",
};

function pickFile(files: string[], kind: "model" | "lexicon" | "tokens"): string | undefined {
  const candidates = files.filter((path) => {
    const name = basename(path).toLowerCase();
    if (kind === "model") {
      return name.endsWith(".onnx") && !name.includes("encoder") && !name.includes("decoder");
    }
    if (kind === "lexicon") return /^lexicon.*\.txt$/iu.test(name);
    return /^tokens?.*\.txt$/iu.test(name);
  });
  return candidates.sort((left, right) => {
    const leftScore = basename(left).toLowerCase() === EXPECTED_FILE_NAME[kind] ? 1 : 0;
    const rightScore = basename(right).toLowerCase() === EXPECTED_FILE_NAME[kind] ? 1 : 0;
    return rightScore - leftScore || left.localeCompare(right);
  })[0];
}

export interface DiscoveredTtsModel {
  model: string;
  lexicon: string;
  tokens: string;
  dataDir?: string;
}

async function findEspeakDataDirectory(modelDirectory: string, root: string): Promise<string | undefined> {
  let current = modelDirectory;
  for (;;) {
    const candidate = join(current, TTS_DATA_DIRECTORY);
    if (await pathExists(candidate)) return candidate;
    if (current === root) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export async function discoverTtsModel(root: string): Promise<DiscoveredTtsModel> {
  const directories = await scanDirectories(root);
  const match = directories
    .map(({ directory, files }) => ({
      directory,
      model: pickFile(files, "model"),
      lexicon: pickFile(files, "lexicon"),
      tokens: pickFile(files, "tokens"),
    }))
    .filter((value) => value.model && value.lexicon && value.tokens)
    .sort((left, right) => {
      const leftScore = basename(left.model!).toLowerCase().includes("int8") ? 1 : 0;
      const rightScore = basename(right.model!).toLowerCase().includes("int8") ? 1 : 0;
      return rightScore - leftScore || left.directory.localeCompare(right.directory);
    })[0];
  if (!match) {
    throw new Error("没有在所选目录中找到完整的 TTS 模型（model.onnx、lexicon.txt 与 tokens.txt）。");
  }
  return {
    model: match.model!,
    lexicon: match.lexicon!,
    tokens: match.tokens!,
    dataDir: await findEspeakDataDirectory(match.directory, root),
  };
}

export function resolveTtsModelPaths(modelDirectory: string): TtsModelPaths {
  const root = join(modelDirectory, "speech");
  const directory = join(root, TTS_MODEL_DIRECTORY);
  return {
    root,
    directory,
    model: join(directory, "model.onnx"),
    lexicon: join(directory, "lexicon.txt"),
    tokens: join(directory, "tokens.txt"),
  };
}

function pathsFromDiscovery(root: string, discovered: DiscoveredTtsModel): TtsModelPaths {
  const directory = dirname(discovered.model);
  // The official Melo zh_en frontend is lexicon-based. Passing espeak data to
  // it changes Chinese phonemization and produces short, unintelligible audio.
  // Other imported VITS models may still require espeak, so keep it for them.
  const dataDir = basename(directory).toLowerCase() === TTS_MODEL_DIRECTORY
    ? undefined
    : discovered.dataDir;
  return { root, directory, ...discovered, dataDir };
}

async function hasRequiredFiles(directory: string): Promise<boolean> {
  return (
    await Promise.all(TTS_MODEL_FILES.map((file) => pathExists(join(directory, file))))
  ).every(Boolean);
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

export const runTtsDownloadScript: TtsScriptRunner = async ({
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
    child.stdout.on("data", (chunk) => process.stdout.write(`[tts-model] ${chunk}`));
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      process.stderr.write(`[tts-model] ${text}`);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `TTS 模型下载脚本退出，代码 ${code ?? "unknown"}。`));
    });
  });
};

export class TtsModelManager {
  private readonly managedPaths: TtsModelPaths;
  private activePaths: TtsModelPaths;
  private ready = false;

  constructor(
    private readonly modelDirectory: string,
    private readonly scriptDirectory: string,
    private readonly runScript: TtsScriptRunner = runTtsDownloadScript,
    private importedDirectory = "",
  ) {
    this.managedPaths = resolveTtsModelPaths(modelDirectory);
    this.activePaths = this.managedPaths;
  }

  get paths(): TtsModelPaths {
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
          await discoverTtsModel(this.importedDirectory),
        );
        this.ready = true;
        return this.ready;
      } catch {
        return false;
      }
    }
    this.ready = await hasRequiredFiles(this.managedPaths.directory);
    return this.ready;
  }

  async importFromDirectory(sourceDirectory: string): Promise<TtsModelPaths> {
    const discovered = await discoverTtsModel(sourceDirectory);
    this.importedDirectory = sourceDirectory;
    this.activePaths = pathsFromDiscovery(sourceDirectory, discovered);
    this.ready = true;
    return this.activePaths;
  }

  async prepare(
    signal: AbortSignal,
    onProgress: (progress: TtsDownloadProgress) => void,
    force = false,
  ): Promise<TtsModelPaths> {
    this.useManagedModels();
    await writableDirectory(this.modelDirectory);
    const modelReady = await hasRequiredFiles(this.managedPaths.directory);
    if (!force && modelReady) return this.managedPaths;
    onProgress({ receivedBytes: 0 });
    await this.runScript({
      scriptPath: join(this.scriptDirectory, TTS_MODEL_SCRIPT),
      modelRoot: this.modelDirectory,
      force,
      signal,
    });
    if (!(await hasRequiredFiles(this.managedPaths.directory))) {
      throw new Error("TTS 下载脚本完成，但模型文件不完整。");
    }
    onProgress({ receivedBytes: 1, totalBytes: 1, percent: 100 });
    this.ready = true;
    return this.managedPaths;
  }
}
