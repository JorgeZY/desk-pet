import { jsonSchema, streamText, tool, type LanguageModelUsage } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../../shared/types";
import {
  createLlamaModelAdapter,
  extractLlamaModelStepMetadata,
  LLAMA_CPP_PROVIDER_METADATA_KEY,
} from "./llama-model-adapter";

function runtimeConfig(): RuntimeConfig {
  return {
    setupComplete: true,
    executable: "llama-server.exe",
    modelMode: "local",
    hfRepo: "",
    modelPath: "model.gguf",
    mmprojPath: "",
    mcpServersConfigPath: "",
    host: "127.0.0.1",
    port: 1234,
    contextSize: 8192,
    gpuLayers: 99,
    threads: 8,
    maxTokens: 512,
    temperature: 0.7,
    topK: 40,
    topP: 0.8,
    minP: 0.05,
    repeatPenalty: 1.1,
    presencePenalty: 0.2,
    autoStart: true,
    chatTemplates: [],
    systemPrompt: "You are helpful.",
    speech: {
      enabled: false,
      shortcut: "F8",
      threads: 4,
      language: "auto",
      modelDirectory: "models/speech",
    },
    tts: {
      enabled: false,
      speed: 1,
      speaker: 0,
      modelDirectory: "models/tts",
    },
    caption: {
      layoutVersion: 3,
      fontSize: 24,
      opacity: 0.8,
    },
  };
}

function sseResponse(): Response {
  const chunks = [
    {
      id: "chatcmpl-1",
      created: 1,
      model: "desk-pet-model",
      choices: [{
        delta: { role: "assistant", reasoning_content: "先检查。" },
        finish_reason: null,
      }],
      timings: { prompt_n: 12, predicted_n: 3 },
    },
    {
      id: "chatcmpl-1",
      created: 1,
      model: "desk-pet-model",
      choices: [{ delta: { content: "完成" }, finish_reason: null }],
    },
    {
      id: "chatcmpl-1",
      created: 1,
      model: "desk-pet-model",
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      timings: { prompt_n: 12, predicted_n: 3, predicted_ms: 25 },
    },
  ];
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("createLlamaModelAdapter", () => {
  it("sends llama.cpp sampling, thinking, tool, and usage stream options", async () => {
    let requestUrl = "";
    let requestBody: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse();
    });
    const adapter = createLlamaModelAdapter(
      runtimeConfig(),
      "http://127.0.0.1:1234/",
      { thinking: true, thinkingEffort: "high", fetch: fetchMock },
    );

    const result = streamText({
      model: adapter.model,
      ...adapter.settings,
      prompt: "读取文件",
      tools: {
        read_file: tool({
          description: "Read a file",
          inputSchema: jsonSchema<{ path: string }>({
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          }),
        }),
      },
    });

    await expect(result.text).resolves.toBe("完成");
    await expect(result.reasoningText).resolves.toBe("先检查。");
    expect(requestUrl).toBe("http://127.0.0.1:1234/v1/chat/completions");
    expect(requestBody).toMatchObject({
      model: "desk-pet-model",
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 512,
      temperature: 0.7,
      top_p: 0.8,
      presence_penalty: 0.2,
      top_k: 40,
      min_p: 0.05,
      repeat_penalty: 1.1,
      reasoning_effort: "high",
      thinking_budget_tokens: 384,
      chat_template_kwargs: {
        enable_thinking: true,
        reasoning_effort: "high",
      },
      parallel_tool_calls: false,
      tool_choice: "auto",
    });
    expect(requestBody.tools).toEqual([
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({ name: "read_file" }),
      }),
    ]);

    const metadata = extractLlamaModelStepMetadata(
      await result.providerMetadata,
      await result.usage,
    );
    expect(metadata).toEqual({
      timings: { prompt_n: 12, predicted_n: 3, predicted_ms: 25 },
      contextUsage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
    });
  });

  it("disables thinking and omits parallel tool calls without tools", async () => {
    let requestBody: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse();
    });
    const adapter = createLlamaModelAdapter(
      runtimeConfig(),
      "http://localhost:1234/v1",
      { fetch: fetchMock },
    );

    const result = streamText({ model: adapter.model, ...adapter.settings, prompt: "你好" });
    await result.text;

    expect(requestBody).toMatchObject({
      reasoning_effort: "none",
      thinking_budget_tokens: 0,
      chat_template_kwargs: {
        enable_thinking: false,
        reasoning_effort: "none",
      },
    });
    expect(requestBody).not.toHaveProperty("parallel_tool_calls");
  });

  it("rejects non-loopback endpoints", () => {
    expect(() => createLlamaModelAdapter(runtimeConfig(), "https://example.com"))
      .toThrow("loopback");
  });
});

describe("extractLlamaModelStepMetadata", () => {
  it("falls back to llama.cpp timings when normalized usage is unavailable", () => {
    const usage: LanguageModelUsage = {
      inputTokens: undefined,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      outputTokens: undefined,
      outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
      totalTokens: undefined,
    };

    expect(extractLlamaModelStepMetadata({
      [LLAMA_CPP_PROVIDER_METADATA_KEY]: {
        timings: { cache_n: 5, prompt_n: 7, predicted_n: 4 },
      },
    }, usage)).toEqual({
      timings: { cache_n: 5, prompt_n: 7, predicted_n: 4 },
      contextUsage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 },
    });
  });
});
