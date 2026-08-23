import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "./config-store";
import {
  buildChatCompletionMessages,
  buildLlamaCommand,
  contextUsageFromCompletion,
  LlamaRuntime,
  reasoningBudgetFor,
} from "./llama-runtime";

afterEach(() => vi.restoreAllMocks());

describe("contextUsageFromCompletion", () => {
  it("includes cached and newly processed llama.cpp prompt tokens", () => {
    expect(contextUsageFromCompletion({ cache_n: 1000, prompt_n: 234, predicted_n: 234 })).toEqual({
      promptTokens: 1234,
      completionTokens: 234,
      totalTokens: 1468,
    });
  });

  it("prefers OpenAI-compatible usage fields when present", () => {
    expect(contextUsageFromCompletion(
      { prompt_n: 1, predicted_n: 2 },
      { prompt_tokens: 800, completion_tokens: 120, total_tokens: 920 },
    )).toEqual({ promptTokens: 800, completionTokens: 120, totalTokens: 920 });
  });
});

describe("buildLlamaCommand", () => {
  it("uses the unified llama serve command and a replaceable HF model", () => {
    const command = buildLlamaCommand({ ...DEFAULT_CONFIG, executable: "llama" });
    expect(command.command).toBe("llama");
    expect(command.args.slice(0, 3)).toEqual([
      "serve",
      "-hf",
      "openbmb/MiniCPM5-1B-GGUF:Q4_K_M",
    ]);
    expect(command.args).toContain("--jinja");
    expect(command.args.slice(command.args.indexOf("--tools"), command.args.indexOf("--tools") + 2))
      .toEqual(["--tools", "all"]);
    expect(command.args).toContain("desk-pet-model");
    expect(command.args).toContain("--cors-origins");
    expect(command.args).toContain("localhost");
  });

  it("does not add a subcommand to llama-server.exe", () => {
    const command = buildLlamaCommand({
      ...DEFAULT_CONFIG,
      executable: "C:\\tools\\llama-server.exe",
      modelMode: "local",
      modelPath: "D:\\models\\any-local-model.gguf",
      mmprojPath: "D:\\models\\vision-mmproj.gguf",
    });
    expect(command.args[0]).toBe("-m");
    expect(command.args[1]).toBe("D:\\models\\any-local-model.gguf");
    expect(command.args).not.toContain("serve");
    expect(command.args).toContain("--mmproj");
    expect(command.args).toContain("D:\\models\\vision-mmproj.gguf");
  });

  it("converts attached images to OpenAI-compatible image_url content", async () => {
    const messages = await buildChatCompletionMessages(
      DEFAULT_CONFIG,
      [{
        id: "user-image",
        role: "user",
        content: "这是什么？",
        images: [{ path: "D:\\images\\cat.png", name: "cat.png", mimeType: "image/png" }],
        createdAt: 1,
      }],
      {
        visionEnabled: true,
        getImageSize: async () => 3,
        readImage: async () => Buffer.from([1, 2, 3]),
      },
    );

    expect(messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "这是什么？" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
      ],
    });
  });

  it("omits unavailable historical images and reports a recoverable warning", async () => {
    const warnings: string[] = [];
    const messages = await buildChatCompletionMessages(
      DEFAULT_CONFIG,
      [
        {
          id: "old-image",
          role: "user",
          content: "看看这张图",
          images: [{ path: "D:\\images\\gone.png", name: "gone.png", mimeType: "image/png" }],
          createdAt: 1,
        },
        { id: "old-answer", role: "assistant", content: "看到了", createdAt: 2 },
        { id: "new-text", role: "user", content: "继续聊", createdAt: 3 },
      ],
      {
        visionEnabled: true,
        getImageSize: async () => { throw new Error("ENOENT"); },
        onWarning: (message) => warnings.push(message),
      },
    );

    expect(messages[1]).toEqual({ role: "user", content: "看看这张图" });
    expect(messages[3]).toEqual({ role: "user", content: "继续聊" });
    expect(warnings).toEqual(["历史图片 gone.png 已不可用，已跳过。"]);
  });

  it("caps images and bytes across the entire completion request", async () => {
    const warnings: string[] = [];
    const readImage = vi.fn(async () => Buffer.from([1]));
    const imageMessages = Array.from({ length: 5 }, (_value, index) => ({
      id: `image-${index}`,
      role: "user" as const,
      content: `图片 ${index}`,
      images: [{
        path: `D:\\images\\${index}.png`,
        name: `${index}.png`,
        mimeType: "image/png" as const,
      }],
      createdAt: index,
    }));

    const messages = await buildChatCompletionMessages(DEFAULT_CONFIG, imageMessages, {
      visionEnabled: true,
      getImageSize: async () => 3 * 1024 * 1024,
      readImage,
      onWarning: (message) => warnings.push(message),
    });

    expect(readImage).toHaveBeenCalledTimes(3);
    expect(readImage).toHaveBeenNthCalledWith(1, "D:\\images\\4.png");
    expect(readImage).toHaveBeenNthCalledWith(3, "D:\\images\\2.png");
    expect(messages[1]).toEqual({ role: "user", content: "图片 0" });
    expect(warnings).toContain("为保护内存，本次请求图片合计不超过 10 MB，较早图片已跳过。");
  });

  it("keeps no more than four recent images across message history", async () => {
    const warnings: string[] = [];
    const readImage = vi.fn(async () => Buffer.from([1]));
    const imageMessages = Array.from({ length: 5 }, (_value, index) => ({
      id: `image-count-${index}`,
      role: "user" as const,
      content: `图片 ${index}`,
      images: [{
        path: `D:\\images\\count-${index}.png`,
        name: `count-${index}.png`,
        mimeType: "image/png" as const,
      }],
      createdAt: index,
    }));

    await buildChatCompletionMessages(DEFAULT_CONFIG, imageMessages, {
      visionEnabled: true,
      getImageSize: async () => 1,
      readImage,
      onWarning: (message) => warnings.push(message),
    });

    expect(readImage).toHaveBeenCalledTimes(4);
    expect(readImage).toHaveBeenNthCalledWith(1, "D:\\images\\count-4.png");
    expect(readImage).toHaveBeenNthCalledWith(4, "D:\\images\\count-1.png");
    expect(warnings).toContain("为保护内存，本次请求仅发送最近 4 张图片，较早图片已跳过。");
  });

  it("strips all historical image metadata when vision is disabled", async () => {
    const readImage = vi.fn(async () => Buffer.from([1]));
    const messages = await buildChatCompletionMessages(
      { ...DEFAULT_CONFIG, mmprojPath: "D:\\models\\vision-mmproj.gguf" },
      [{
        id: "old-image",
        role: "user",
        content: "只保留文本",
        images: [{ path: "D:\\images\\cat.png", name: "cat.png", mimeType: "image/png" }],
        createdAt: 1,
      }],
      { visionEnabled: false, readImage },
    );

    expect(readImage).not.toHaveBeenCalled();
    expect(messages[1]).toEqual({ role: "user", content: "只保留文本" });
  });

  it("adds an MCP servers config only when custom tools are configured", () => {
    const path = "D:\\tools\\mcp.json";
    const command = buildLlamaCommand({ ...DEFAULT_CONFIG, mcpServersConfigPath: path });
    expect(command.command).toBe(process.platform === "win32" ? "llama-server.exe" : "llama-server");
    expect(command.args[0]).not.toBe("serve");
    expect(command.args.slice(
      command.args.indexOf("--mcp-servers-config"),
      command.args.indexOf("--mcp-servers-config") + 2,
    )).toEqual(["--mcp-servers-config", path]);
    expect(buildLlamaCommand(DEFAULT_CONFIG).args).not.toContain("--mcp-servers-config");
  });

  it("uses the sibling dedicated server for an absolute unified llama path with MCP", () => {
    const command = buildLlamaCommand({
      ...DEFAULT_CONFIG,
      executable: "C:\\llama.cpp\\llama.exe",
      mcpServersConfigPath: "D:\\tools\\mcp.json",
    });

    expect(command.command).toBe("C:\\llama.cpp\\llama-server.exe");
    expect(command.args[0]).not.toBe("serve");
  });

  it("injects document text and replays completed tool calls", async () => {
    const messages = await buildChatCompletionMessages(DEFAULT_CONFIG, [
      {
        id: "document",
        role: "user",
        content: "总结附件",
        documents: [{
          path: "D:\\docs\\notes.pdf",
          name: "notes.pdf",
          mimeType: "application/pdf",
          text: "附件正文",
          characterCount: 4,
        }],
        createdAt: 1,
      },
      {
        id: "assistant",
        role: "assistant",
        content: "最终回答",
        toolCalls: [{
          id: "call-1",
          name: "read_file",
          displayName: "Read file",
          arguments: "{\"path\":\"notes.txt\"}",
          status: "completed",
          requiresApproval: false,
          result: "文件内容",
        }],
        createdAt: 2,
      },
    ], { visionEnabled: false });

    expect(messages[1]?.content).toContain("<document name=\"notes.pdf\">");
    expect(messages.slice(2)).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call-1",
          type: "function",
          function: { name: "read_file", arguments: "{\"path\":\"notes.txt\"}" },
        }],
      },
      { role: "tool", content: "文件内容", tool_call_id: "call-1" },
      { role: "assistant", content: "最终回答" },
    ]);
  });

  it("budgets documents across the request context and keeps the newest attachment first", async () => {
    const warnings: string[] = [];
    const config = {
      ...DEFAULT_CONFIG,
      contextSize: 1024,
      maxTokens: 128,
      systemPrompt: "系统",
    };
    const messages = await buildChatCompletionMessages(config, [
      {
        id: "old-document",
        role: "user",
        content: "旧问题",
        documents: [{
          path: "D:\\docs\\old.txt",
          name: "old.txt",
          mimeType: "text/plain",
          text: "旧".repeat(400),
          characterCount: 400,
        }],
        createdAt: 1,
      },
      { id: "answer", role: "assistant", content: "旧回答", createdAt: 2 },
      {
        id: "new-document",
        role: "user",
        content: "新问题",
        documents: [{
          path: "D:\\docs\\new.txt",
          name: "new.txt",
          mimeType: "text/plain",
          text: "新".repeat(400),
          characterCount: 400,
        }],
        createdAt: 3,
      },
    ], {
      visionEnabled: false,
      onWarning: (message) => warnings.push(message),
    });

    expect(messages[3]?.content).toContain("新".repeat(20));
    expect(messages[1]).toEqual({ role: "user", content: "旧问题" });
    const requestTextBytes = messages.reduce((total, message) => (
      total + (typeof message.content === "string" ? Buffer.byteLength(message.content, "utf8") : 0)
    ), 0);
    expect(requestTextBytes).toBeLessThanOrEqual(
      config.contextSize - config.maxTokens - 3 * 16 - 256,
    );
    expect(warnings).toEqual([
      "附件内容已按 1,024 token 上下文预算截断，优先保留最近消息中的文档。",
    ]);
  });

  it("keeps medium reasoning within half of the configured output budget", () => {
    expect(reasoningBudgetFor("minimal", 512)).toBe(51);
    expect(reasoningBudgetFor("medium", 512)).toBe(256);
    expect(reasoningBudgetFor("xhigh", 512)).toBe(460);
    expect(reasoningBudgetFor("max", 512)).toBe(-1);
  });

  it("does not download an uncached remote model during automatic startup", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("not running"));
    let allowDownload: boolean | undefined;
    const runtime = new LlamaRuntime(DEFAULT_CONFIG, async (_modelId, options) => {
      allowDownload = options.allowDownload;
      return null;
    });

    await runtime.start(false);
    await vi.waitFor(() => expect(runtime.snapshot.message).toContain("自动下载或导入本地 GGUF"));
    expect(allowDownload).toBe(false);
    expect(runtime.snapshot.phase).toBe("stopped");
  });
});
