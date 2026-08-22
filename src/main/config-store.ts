import { app } from "electron";
import { promises as fs } from "node:fs";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import type { RuntimeConfig } from "../shared/types";
import { DEFAULT_CHAT_TEMPLATES, normalizeChatTemplates } from "../shared/chat-templates";
import { normalizeCaptionConfig } from "../shared/caption-window";

const LEGACY_DEFAULT_SYSTEM_PROMPT =
  "你是一只住在用户桌面上的 AI 小猫，名字叫团子。你温暖、机灵、简洁，优先用中文回答。不要假装能看到屏幕或执行未提供的操作。一般回答控制在 1 到 4 个短段落；遇到技术问题时可以更详细。";

export const DEFAULT_CONFIG: RuntimeConfig = {
  setupComplete: false,
  executable: "llama",
  modelMode: "huggingface",
  hfRepo: "openbmb/MiniCPM5-1B-GGUF:Q4_K_M",
  modelPath: "",
  mmprojPath: "",
  mcpServersConfigPath: "",
  host: "127.0.0.1",
  port: 18766,
  contextSize: 8192,
  gpuLayers: 999,
  threads: Math.max(2, cpus().length - 1),
  maxTokens: 512,
  temperature: 0.7,
  topK: 40,
  topP: 0.95,
  minP: 0.05,
  repeatPenalty: 1.0,
  presencePenalty: 0.0,
  autoStart: true,
  chatTemplates: [...DEFAULT_CHAT_TEMPLATES],
  speech: {
    enabled: true,
    shortcut: "F8",
    threads: 2,
    language: "auto",
    modelDirectory: "",
  },
  tts: {
    enabled: true,
    speed: 1.0,
    speaker: 0,
    modelDirectory: "",
  },
  caption: {
    layoutVersion: 3,
    fontSize: 22,
    opacity: 0.96,
  },
  systemPrompt:
    "你是团子，一只住在用户桌面上的 AI 橘猫，也是一位可靠的本地助手。你温暖、机灵，带一点橘猫式幽默：可以偶尔自然地使用偷吃、掉毛、晒太阳、占内存或显存等轻松梗，但不要每句话都强行卖萌或反复说“喵”。优先用中文回答，先解决问题，再适度展现性格；事实不确定时要坦诚说明，不要编造。不要假装能看到屏幕，也不要声称执行了用户未提供的操作。一般回答控制在 1 到 4 个短段落；遇到技术问题时可以更详细、结构更清晰。",
};

const asFiniteNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const clampInt = (value: unknown, fallback: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(asFiniteNumber(value, fallback))));

function normalizeSystemPrompt(value: unknown): string {
  const prompt = typeof value === "string" ? value.trim() : "";
  return !prompt || prompt === LEGACY_DEFAULT_SYSTEM_PROMPT
    ? DEFAULT_CONFIG.systemPrompt
    : prompt;
}

export function normalizeConfig(value: unknown): RuntimeConfig {
  const raw = value && typeof value === "object" ? (value as Partial<RuntimeConfig>) : {};
  const rawSpeech = raw.speech as
    | (Partial<RuntimeConfig["speech"]> & { globalShortcut?: unknown })
    | undefined;
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
    mmprojPath: typeof raw.mmprojPath === "string" ? raw.mmprojPath.trim() : "",
    mcpServersConfigPath:
      typeof raw.mcpServersConfigPath === "string" ? raw.mcpServersConfigPath.trim() : "",
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
    topK: clampInt(raw.topK, DEFAULT_CONFIG.topK, 0, 1000),
    topP: Math.min(1, Math.max(0, asFiniteNumber(raw.topP, DEFAULT_CONFIG.topP))),
    minP: Math.min(1, Math.max(0, asFiniteNumber(raw.minP, DEFAULT_CONFIG.minP))),
    repeatPenalty: Math.min(
      2,
      Math.max(0, asFiniteNumber(raw.repeatPenalty, DEFAULT_CONFIG.repeatPenalty)),
    ),
    presencePenalty: Math.min(
      2,
      Math.max(-2, asFiniteNumber(raw.presencePenalty, DEFAULT_CONFIG.presencePenalty)),
    ),
    autoStart: raw.autoStart !== false,
    chatTemplates: normalizeChatTemplates(raw.chatTemplates),
    speech: {
      // v0.1.6 exposed microphone input and the global F8 hook separately.
      // Preserve the safest prior choice when folding them into one switch:
      // either legacy switch being off keeps the combined feature off.
      enabled: rawSpeech?.enabled !== false && rawSpeech?.globalShortcut !== false,
      shortcut: "F8",
      threads: clampInt(rawSpeech?.threads, DEFAULT_CONFIG.speech.threads, 1, 16),
      language: "auto",
      modelDirectory:
        typeof rawSpeech?.modelDirectory === "string"
          ? rawSpeech.modelDirectory.trim()
          : "",
    },
    tts: {
      enabled: raw.tts?.enabled !== false,
      speed: Math.min(
        2,
        Math.max(0.5, asFiniteNumber(raw.tts?.speed, DEFAULT_CONFIG.tts.speed)),
      ),
      speaker: clampInt(raw.tts?.speaker, DEFAULT_CONFIG.tts.speaker, 0, 200),
      modelDirectory:
        typeof raw.tts?.modelDirectory === "string"
          ? raw.tts.modelDirectory.trim()
          : "",
    },
    caption: normalizeCaptionConfig(raw.caption),
    systemPrompt: normalizeSystemPrompt(raw.systemPrompt),
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
  if (config.mmprojPath && !config.mmprojPath.toLowerCase().endsWith(".gguf")) {
    errors.push("视觉投影模型必须是 .gguf 文件。");
  }
  if (
    config.mcpServersConfigPath &&
    !config.mcpServersConfigPath.toLowerCase().endsWith(".json")
  ) {
    errors.push("MCP Servers 配置必须是 .json 文件。");
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
