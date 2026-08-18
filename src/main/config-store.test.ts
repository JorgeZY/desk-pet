import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, normalizeConfig, validateConfig } from "./config-store";
import { DEFAULT_CHAT_TEMPLATES } from "../shared/chat-templates";

describe("runtime config", () => {
  it("keeps a lightweight GGUF as the replaceable remote default", () => {
    const config = normalizeConfig(undefined);
    expect(config.modelMode).toBe("huggingface");
    expect(config.hfRepo).toBe("openbmb/MiniCPM5-1B-GGUF:Q4_K_M");
    expect(config.contextSize).toBe(8192);
    expect(config.mmprojPath).toBe("");
    expect(config.mcpServersConfigPath).toBe("");
    expect(config.topK).toBe(40);
    expect(config.topP).toBe(0.95);
    expect(config.minP).toBe(0.05);
    expect(config.repeatPenalty).toBe(1);
    expect(config.presencePenalty).toBe(0);
    expect(config.speech.modelDirectory).toBe("");
    expect(config.chatTemplates).toEqual(DEFAULT_CHAT_TEMPLATES);
  });

  it("defaults to the orange-cat personality without overwriting a custom prompt", () => {
    expect(DEFAULT_CONFIG.systemPrompt).toContain("橘猫式幽默");
    expect(DEFAULT_CONFIG.systemPrompt).toContain("先解决问题");

    const migrated = normalizeConfig({
      ...DEFAULT_CONFIG,
      systemPrompt:
        "你是一只住在用户桌面上的 AI 小猫，名字叫团子。你温暖、机灵、简洁，优先用中文回答。不要假装能看到屏幕或执行未提供的操作。一般回答控制在 1 到 4 个短段落；遇到技术问题时可以更详细。",
    });
    expect(migrated.systemPrompt).toBe(DEFAULT_CONFIG.systemPrompt);

    const config = normalizeConfig({
      ...DEFAULT_CONFIG,
      systemPrompt: "保持专业，直接回答。",
    });
    expect(config.systemPrompt).toBe("保持专业，直接回答。");
  });

  it("clamps unsafe numeric values", () => {
    const config = normalizeConfig({
      ...DEFAULT_CONFIG,
      port: 1,
      contextSize: 999_999,
      temperature: -4,
      topK: 9_999,
      topP: -1,
      minP: 4,
      repeatPenalty: -3,
      presencePenalty: 9,
      threads: 0,
    });
    expect(config.port).toBe(1024);
    expect(config.contextSize).toBe(131072);
    expect(config.temperature).toBe(0);
    expect(config.topK).toBe(1000);
    expect(config.topP).toBe(0);
    expect(config.minP).toBe(1);
    expect(config.repeatPenalty).toBe(0);
    expect(config.presencePenalty).toBe(2);
    expect(config.threads).toBe(1);
    expect(config.speech.threads).toBe(2);
  });

  it("migrates speech defaults and clamps speech threads", () => {
    const migrated = normalizeConfig({ ...DEFAULT_CONFIG, speech: undefined });
    expect(migrated.speech).toEqual(DEFAULT_CONFIG.speech);

    const configured = normalizeConfig({
      ...DEFAULT_CONFIG,
      speech: { ...DEFAULT_CONFIG.speech, enabled: false, threads: 99 },
    });
    expect(configured.speech.enabled).toBe(false);
    expect(configured.speech.threads).toBe(16);
    expect(configured.speech.modelDirectory).toBe("");

    const imported = normalizeConfig({
      ...DEFAULT_CONFIG,
      speech: { ...DEFAULT_CONFIG.speech, modelDirectory: " D:\\speech-models " },
    });
    expect(imported.speech.modelDirectory).toBe("D:\\speech-models");
  });

  it("uses the single speech switch when migrating the legacy shortcut toggle", () => {
    const legacySpeech = {
      ...DEFAULT_CONFIG.speech,
      enabled: true,
      globalShortcut: false,
    };
    const migrated = normalizeConfig({ ...DEFAULT_CONFIG, speech: legacySpeech });

    expect(migrated.speech.enabled).toBe(false);
    expect(migrated.speech).not.toHaveProperty("globalShortcut");
  });

  it("migrates and bounds the three editable chat templates", () => {
    expect(normalizeConfig({ ...DEFAULT_CONFIG, chatTemplates: undefined }).chatTemplates)
      .toEqual(DEFAULT_CHAT_TEMPLATES);

    const configured = normalizeConfig({
      ...DEFAULT_CONFIG,
      chatTemplates: ["  模板一  ", "", "x".repeat(120), "不会保存"],
    });
    expect(configured.chatTemplates).toEqual(["模板一", "", "x".repeat(80)]);
  });

  it("migrates tts defaults and clamps speed and speaker", () => {
    const migrated = normalizeConfig({ ...DEFAULT_CONFIG, tts: undefined });
    expect(migrated.tts).toEqual(DEFAULT_CONFIG.tts);
    expect(migrated.tts.enabled).toBe(true);
    expect(migrated.tts.speed).toBe(1);
    expect(migrated.tts.speaker).toBe(0);

    const configured = normalizeConfig({
      ...DEFAULT_CONFIG,
      tts: { ...DEFAULT_CONFIG.tts, speed: 9, speaker: -4 },
    });
    expect(configured.tts.speed).toBe(2);
    expect(configured.tts.speaker).toBe(0);

    const slow = normalizeConfig({
      ...DEFAULT_CONFIG,
      tts: { ...DEFAULT_CONFIG.tts, speed: 0.1, speaker: 300 },
    });
    expect(slow.tts.speed).toBe(0.5);
    expect(slow.tts.speaker).toBe(200);

    const imported = normalizeConfig({
      ...DEFAULT_CONFIG,
      tts: { ...DEFAULT_CONFIG.tts, modelDirectory: " D:\\tts-models " },
    });
    expect(imported.tts.modelDirectory).toBe("D:\\tts-models");
  });

  it("requires a GGUF file in local mode", () => {
    const missing = normalizeConfig({ ...DEFAULT_CONFIG, modelMode: "local", modelPath: "" });
    expect(validateConfig(missing)).toContain("请选择 llama.cpp 支持的 GGUF 模型。");

    const wrongType = normalizeConfig({
      ...DEFAULT_CONFIG,
      modelMode: "local",
      modelPath: "model.bin",
    });
    expect(validateConfig(wrongType)).toContain("本地模型必须是 .gguf 文件。");
  });

  it("accepts another llama.cpp Hugging Face model in remote mode", () => {
    const config = normalizeConfig({
      ...DEFAULT_CONFIG,
      hfRepo: "someone/another-model:Q4_K_M",
    });
    expect(validateConfig(config)).toEqual([]);
  });

  it("normalizes and validates the optional MCP servers config", () => {
    const config = normalizeConfig({
      ...DEFAULT_CONFIG,
      mcpServersConfigPath: " D:\\tools\\mcp.json ",
    });
    expect(config.mcpServersConfigPath).toBe("D:\\tools\\mcp.json");
    expect(validateConfig(config)).toEqual([]);
    expect(validateConfig({ ...config, mcpServersConfigPath: "D:\\tools\\mcp.yaml" }))
      .toContain("MCP Servers 配置必须是 .json 文件。");
  });

  it("accepts an optional GGUF mmproj and rejects other file types", () => {
    expect(validateConfig(normalizeConfig({ ...DEFAULT_CONFIG, mmprojPath: "vision-mmproj.gguf" }))).toEqual([]);
    expect(validateConfig(normalizeConfig({ ...DEFAULT_CONFIG, mmprojPath: "vision-mmproj.bin" })))
      .toContain("视觉投影模型必须是 .gguf 文件。");
  });
});
