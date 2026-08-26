import type { DynamicToolUIPart } from "ai";
import { describe, expect, it } from "vitest";
import type { ChatMessage, ChatToolCall } from "../../shared/types";
import {
  chatMessageToDesktopUIMessage,
  desktopUIMessageToChatMessage,
  readDesktopToolMetadata,
  type DesktopUIMessage,
} from "./desktop-ui-message";

describe("desktop UI message adapters", () => {
  it("round-trips every persisted chat field and tool status", () => {
    const toolCalls: ChatToolCall[] = [
      toolCall("pending", "pending-approval", { requiresApproval: true }),
      toolCall("running", "running"),
      toolCall("completed", "completed", { result: "done" }),
      toolCall("denied", "denied", {
        requiresApproval: true,
        result: "用户拒绝了操作。",
      }),
      toolCall("error", "error", {
        requiresApproval: true,
        error: "boom",
      }),
    ];
    const message: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      content: "最终回答",
      reasoning: "内部推理",
      images: [{
        path: "D:\\cat.png",
        name: "cat.png",
        mimeType: "image/png",
        previewUrl: "blob:cat",
      }],
      documents: [{
        path: "D:\\notes.pdf",
        name: "notes.pdf",
        mimeType: "application/pdf",
        text: "document body",
        characterCount: 42,
        truncated: true,
      }],
      toolCalls,
      contextUsage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 },
      createdAt: 1234,
    };

    expect(desktopUIMessageToChatMessage(
      chatMessageToDesktopUIMessage(message),
    )).toMatchObject(message);
  });

  it("preserves absent terminal result and error fields", () => {
    const message: ChatMessage = {
      id: "assistant-2",
      role: "assistant",
      content: "",
      toolCalls: [
        toolCall("completed", "completed"),
        toolCall("error", "error"),
      ],
      createdAt: 50,
    };

    expect(desktopUIMessageToChatMessage(
      chatMessageToDesktopUIMessage(message),
    )).toMatchObject(message);
  });

  it("concatenates streamed text and reasoning parts", () => {
    const message: DesktopUIMessage = {
      id: "assistant-stream",
      role: "assistant",
      metadata: { createdAt: 90 },
      parts: [
        { type: "reasoning", id: "r1", text: "先", state: "done" },
        { type: "reasoning", id: "r2", text: "思考", state: "done" },
        { type: "text", text: "第一段", state: "done" },
        { type: "text", text: "第二段", state: "done" },
      ],
    };

    expect(desktopUIMessageToChatMessage(message)).toEqual({
      id: "assistant-stream",
      role: "assistant",
      content: "第一段第二段",
      parts: [
        { type: "reasoning", text: "先" },
        { type: "reasoning", text: "思考" },
        { type: "text", text: "第一段" },
        { type: "text", text: "第二段" },
      ],
      reasoning: "先思考",
      createdAt: 90,
    });
  });

  it("preserves interleaved text, tool, result, and text parts", () => {
    const call = toolCall("ordered", "completed", { result: "tool output" });
    const source: DesktopUIMessage = {
      id: "assistant-ordered",
      role: "assistant",
      metadata: { createdAt: 100 },
      parts: [
        { type: "text", text: "调用前", state: "done" },
        dynamicToolPart(call),
        {
          type: "data-tool-result",
          id: "result-ordered",
          data: {
            toolCallId: call.id,
            status: "completed",
            resultPresent: true,
            errorPresent: false,
            result: "tool output",
          },
        },
        { type: "text", text: "调用后", state: "done" },
      ],
    };

    const persisted = desktopUIMessageToChatMessage(source);
    const restored = chatMessageToDesktopUIMessage(persisted);

    expect(persisted.content).toBe("调用前调用后");
    expect(persisted.parts?.map((part) => part.type)).toEqual([
      "text",
      "dynamic-tool",
      "data-tool-result",
      "text",
    ]);
    expect(restored.parts.map((part) => part.type)).toEqual([
      "text",
      "dynamic-tool",
      "data-tool-result",
      "text",
    ]);
    expect(restored.parts.filter((part) => part.type === "text").map((part) => part.text))
      .toEqual(["调用前", "调用后"]);
  });

  it("preserves attachment and reasoning positions around separate text parts", () => {
    const source: DesktopUIMessage = {
      id: "assistant-attachments",
      role: "assistant",
      metadata: { createdAt: 101 },
      parts: [
        {
          type: "data-image-attachment",
          id: "image-1",
          data: { path: "D:\\cat.png", name: "cat.png", mimeType: "image/png" },
        },
        { type: "text", text: "图片后", state: "done" },
        { type: "reasoning", id: "reasoning-1", text: "再想一下", state: "done" },
        {
          type: "data-document-attachment",
          id: "document-1",
          data: {
            path: "D:\\notes.txt",
            name: "notes.txt",
            mimeType: "text/plain",
            text: "notes",
            characterCount: 5,
          },
        },
        { type: "text", text: "文档后", state: "done" },
      ],
    };

    const restored = chatMessageToDesktopUIMessage(
      desktopUIMessageToChatMessage(source),
    );

    expect(restored.parts.map((part) => part.type)).toEqual([
      "data-image-attachment",
      "text",
      "reasoning",
      "data-document-attachment",
      "text",
    ]);
  });

  it("rejects system messages because the SQLite contract only stores chat roles", () => {
    const message: DesktopUIMessage = {
      id: "system",
      role: "system",
      parts: [{ type: "text", text: "hidden" }],
    };

    expect(() => desktopUIMessageToChatMessage(message, 1)).toThrow(
      "System UI messages cannot be stored",
    );
  });

  it("exposes request routing metadata for tool approvals", () => {
    const part: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "write_file",
      toolCallId: "call-1",
      title: "Write File",
      state: "approval-requested",
      input: { path: "a.txt" },
      approval: { id: "approval-1" },
      toolMetadata: {
        desktopDisplayName: "写入文件",
        desktopRequiresApproval: true,
        desktopArguments: "{\"path\":\"a.txt\"}",
        desktopRequestId: "request-1",
      },
    };

    expect(readDesktopToolMetadata(part)).toEqual({
      displayName: "写入文件",
      requiresApproval: true,
      arguments: "{\"path\":\"a.txt\"}",
      requestId: "request-1",
    });
  });
});

function toolCall(
  id: string,
  status: ChatToolCall["status"],
  overrides: Partial<ChatToolCall> = {},
): ChatToolCall {
  return {
    id,
    name: `tool_${id}`,
    displayName: `Tool ${id}`,
    arguments: `{\n  \"id\": \"${id}\"\n}`,
    status,
    requiresApproval: false,
    ...overrides,
  };
}

function dynamicToolPart(call: ChatToolCall): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolName: call.name,
    toolCallId: call.id,
    title: call.displayName,
    state: "output-available",
    input: JSON.parse(call.arguments),
    output: call.result ?? "",
    toolMetadata: {
      desktopDisplayName: call.displayName,
      desktopRequiresApproval: call.requiresApproval,
      desktopArguments: call.arguments,
    },
  };
}
