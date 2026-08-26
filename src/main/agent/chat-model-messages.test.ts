import { describe, expect, it, vi } from "vitest";
import { buildAgentModelMessages } from "./chat-model-messages";

describe("buildAgentModelMessages", () => {
  it("keeps typed text, documents, and images as separate AI SDK parts", async () => {
    const messages = await buildAgentModelMessages([{
      id: "user",
      role: "user",
      content: "总结附件",
      documents: [{
        path: "D:\\docs\\notes.txt",
        name: "notes.txt",
        mimeType: "text/plain",
        text: "附件正文",
        characterCount: 4,
      }],
      images: [{ path: "D:\\images\\cat.png", name: "cat.png", mimeType: "image/png" }],
      createdAt: 1,
    }], {
      visionEnabled: true,
      getImageSize: async () => 3,
      readImage: async () => Buffer.from([1, 2, 3]),
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "总结附件" },
        { type: "text", text: expect.stringContaining("<document name=\"notes.txt\">") },
        { type: "image", mediaType: "image/png" },
      ],
    });
  });

  it("replays terminal tool calls without an intermediate OpenAI message type", async () => {
    const messages = await buildAgentModelMessages([{
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
      }, {
        id: "call-2",
        name: "write_file",
        displayName: "Write file",
        arguments: "not-json",
        status: "denied",
        requiresApproval: true,
        result: "用户拒绝",
      }],
      createdAt: 1,
    }]);

    expect(messages).toEqual([
      {
        role: "assistant",
        content: [{
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "read_file",
          input: { path: "notes.txt" },
        }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "read_file",
          output: { type: "text", value: "文件内容" },
        }],
      },
      expect.objectContaining({ role: "assistant" }),
      expect.objectContaining({ role: "tool" }),
      { role: "assistant", content: "最终回答" },
    ]);
    expect(messages[2]).toMatchObject({
      content: [{ input: { rawArguments: "not-json" } }],
    });
  });

  it("keeps the newest four images and reports unavailable files", async () => {
    const warnings: string[] = [];
    const readImage = vi.fn(async (path: string) => {
      if (path.endsWith("gone.png")) throw new Error("ENOENT");
      return Buffer.from([1]);
    });
    const source = Array.from({ length: 6 }, (_value, index) => ({
      id: `image-${index}`,
      role: "user" as const,
      content: `图片 ${index}`,
      images: [{
        path: index === 5 ? "D:\\images\\gone.png" : `D:\\images\\${index}.png`,
        name: index === 5 ? "gone.png" : `${index}.png`,
        mimeType: "image/png" as const,
      }],
      createdAt: index,
    }));

    await buildAgentModelMessages(source, {
      visionEnabled: true,
      getImageSize: async () => 1,
      readImage,
      onWarning: (warning) => warnings.push(warning),
    });

    expect(readImage).toHaveBeenCalledTimes(5);
    expect(warnings).toContain("历史图片 gone.png 已不可用，已跳过。");
    expect(warnings).toContain("为保护内存，本次请求仅发送最近 4 张图片，较早图片已跳过。");
  });
});
