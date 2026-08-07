import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "./config-store";
import { buildChatCompletionMessages, buildLlamaCommand, LlamaRuntime } from "./llama-runtime";

afterEach(() => vi.restoreAllMocks());

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
