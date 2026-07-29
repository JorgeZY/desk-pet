import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, normalizeConfig, validateConfig } from "./config-store";

describe("runtime config", () => {
  it("keeps a lightweight GGUF as the replaceable remote default", () => {
    const config = normalizeConfig(undefined);
    expect(config.modelMode).toBe("huggingface");
    expect(config.hfRepo).toBe("openbmb/MiniCPM5-1B-GGUF:Q4_K_M");
    expect(config.contextSize).toBe(8192);
  });

  it("clamps unsafe numeric values", () => {
    const config = normalizeConfig({
      ...DEFAULT_CONFIG,
      port: 1,
      contextSize: 999_999,
      temperature: -4,
      threads: 0,
    });
    expect(config.port).toBe(1024);
    expect(config.contextSize).toBe(131072);
    expect(config.temperature).toBe(0);
    expect(config.threads).toBe(1);
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
});
