import { describe, expect, it } from "vitest";
import type { RuntimeConfig } from "../shared/types";
import { DEFAULT_CONFIG } from "./config-store";
import { agentExecutionConfigChanged } from "./agent-execution-config";

function config(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    ...DEFAULT_CONFIG,
    toolSettings: { ...DEFAULT_CONFIG.toolSettings },
    embedding: { ...DEFAULT_CONFIG.embedding },
    modelParameterOverrides: { ...DEFAULT_CONFIG.modelParameterOverrides },
    chatTemplates: [...DEFAULT_CONFIG.chatTemplates],
    speech: { ...DEFAULT_CONFIG.speech },
    tts: { ...DEFAULT_CONFIG.tts },
    caption: { ...DEFAULT_CONFIG.caption },
    ...overrides,
  };
}

describe("agentExecutionConfigChanged", () => {
  it("ignores settings that do not affect long-task execution", () => {
    const previous = config();
    const next = config({
      setupComplete: true,
      autoStart: false,
      chatTemplates: ["自定义聊天模板"],
      speech: { ...previous.speech, enabled: false },
      tts: { ...previous.tts, speed: 1.25 },
      caption: { ...previous.caption, fontSize: 28 },
    });

    expect(agentExecutionConfigChanged(previous, next)).toBe(false);
  });

  it("detects model and tool changes", () => {
    const previous = config();

    expect(agentExecutionConfigChanged(previous, config({ temperature: 0.9 }))).toBe(true);
    expect(agentExecutionConfigChanged(previous, config({
      toolSettings: { ...previous.toolSettings, mcpEnabled: false },
    }))).toBe(true);
  });
});
