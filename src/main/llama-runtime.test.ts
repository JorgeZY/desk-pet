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
      async () => Buffer.from([1, 2, 3]),
    );

    expect(messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "这是什么？" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
      ],
    });
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
