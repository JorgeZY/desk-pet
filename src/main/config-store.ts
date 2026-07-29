import { app } from "electron";
import { promises as fs } from "node:fs";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import type { RuntimeConfig } from "../shared/types";

export const DEFAULT_CONFIG: RuntimeConfig = {
  setupComplete: false,
  executable: "llama",
  modelMode: "huggingface",
  hfRepo: "openbmb/MiniCPM5-1B-GGUF:Q4_K_M",
  modelPath: "",
  host: "127.0.0.1",
  port: 18766,
  contextSize: 8192,
  gpuLayers: 999,
  threads: Math.max(2, cpus().length - 1),
  maxTokens: 512,
  temperature: 0.7,
  autoStart: true,
  systemPrompt:
    "你是一只住在用户桌面上的 AI 小猫，名字叫团子。你温暖、机灵、简洁，优先用中文回答。不要假装能看到屏幕或执行未提供的操作。一般回答控制在 1 到 4 个短段落；遇到技术问题时可以更详细。",
};

const asFiniteNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const clampInt = (value: unknown, fallback: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(asFiniteNumber(value, fallback))));

export function normalizeConfig(value: unknown): RuntimeConfig {
  const raw = value && typeof value === "object" ? (value as Partial<RuntimeConfig>) : {};
  return {
    setupComplete: raw.setupComplete === true,
    executable:
      typeof raw.executable === "string" && raw.executable.trim()
        ? raw.executable.trim()
        : DEFAULT_CONFIG.executable,
    modelMode: raw.modelMode === "local" ? "local" : "huggingface",
    hfRepo:
      typeof raw.hfRepo === "string" && raw.hfRepo.trim()
        ? raw.hfRepo.trim()
        : DEFAULT_CONFIG.hfRepo,
    modelPath: typeof raw.modelPath === "string" ? raw.modelPath.trim() : "",
    host: "127.0.0.1",
    port: clampInt(raw.port, DEFAULT_CONFIG.port, 1024, 65535),
    contextSize: clampInt(raw.contextSize, DEFAULT_CONFIG.contextSize, 512, 131072),
    gpuLayers: clampInt(raw.gpuLayers, DEFAULT_CONFIG.gpuLayers, 0, 999),
    threads: clampInt(raw.threads, DEFAULT_CONFIG.threads, 1, 256),
    maxTokens: clampInt(raw.maxTokens, DEFAULT_CONFIG.maxTokens, 32, 8192),
    temperature: Math.min(
      2,
      Math.max(0, asFiniteNumber(raw.temperature, DEFAULT_CONFIG.temperature)),
    ),
    autoStart: raw.autoStart !== false,
    systemPrompt:
      typeof raw.systemPrompt === "string" && raw.systemPrompt.trim()
        ? raw.systemPrompt.trim()
        : DEFAULT_CONFIG.systemPrompt,
  };
}

export function validateConfig(config: RuntimeConfig): string[] {
  const errors: string[] = [];
  if (!config.executable.trim()) errors.push("请选择 llama.cpp 可执行文件。");
  if (config.modelMode === "huggingface" && !config.hfRepo.includes("/")) {
    errors.push("Hugging Face 模型标识应为 owner/repo:quant。");
  }
  if (config.modelMode === "local") {
    if (!config.modelPath) errors.push("请选择 llama.cpp 支持的 GGUF 模型。");
    if (config.modelPath && !config.modelPath.toLowerCase().endsWith(".gguf")) {
      errors.push("本地模型必须是 .gguf 文件。");
    }
  }
  return errors;
}

export class ConfigStore {
  private readonly filePath: string;

  constructor(filePath = join(app.getPath("userData"), "config.json")) {
    this.filePath = filePath;
  }

  async read(): Promise<RuntimeConfig> {
    try {
      const contents = await fs.readFile(this.filePath, "utf8");
      return normalizeConfig(JSON.parse(contents));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      return { ...DEFAULT_CONFIG };
    }
  }

  async write(value: RuntimeConfig): Promise<RuntimeConfig> {
    const config = normalizeConfig(value);
    const errors = validateConfig(config);
    if (errors.length) throw new Error(errors.join("\n"));

    await fs.mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await fs.rename(temporaryPath, this.filePath);
    return config;
  }
}
