import type { UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import type { ChatEvent, ChatRequest } from "../../shared/types";
import { chatMessageToDesktopUIMessage } from "./desktop-ui-message";
import {
  CONTINUATION_INSTRUCTION,
  ElectronChatTransport,
  type ElectronChatApi,
} from "./electron-chat-transport";

class FakeChatApi implements ElectronChatApi {
  readonly requests: ChatRequest[] = [];
  readonly aborts: string[] = [];
  private readonly listeners = new Set<(event: ChatEvent) => void>();

  startChat = (request: ChatRequest): void => {
    this.requests.push(request);
  };

  abortChat = (requestId: string): void => {
    this.aborts.push(requestId);
  };

  onChatEvent = (listener: (event: ChatEvent) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  emit(event: ChatEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

describe("ElectronChatTransport", () => {
  it("converts requests and strictly filters events by request id", async () => {
    const api = new FakeChatApi();
    const ids = ["request-1"];
    const transport = new ElectronChatTransport(api, {
      createId: () => ids.shift() ?? "unexpected",
      now: () => 100,
    });
    const user = chatMessageToDesktopUIMessage({
      id: "user-1",
      role: "user",
      content: "hello",
      createdAt: 10,
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-1",
      messageId: undefined,
      messages: [user],
      abortSignal: undefined,
      body: { thinking: true, thinkingEffort: "high" },
    });
    api.emit({ requestId: "another-request", type: "delta", text: "wrong" });
    api.emit({ requestId: "request-1", type: "delta", text: "right" });
    api.emit({
      requestId: "request-1",
      type: "done",
      contextUsage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
    });
    const chunks = await readChunks(stream);

    expect(api.requests).toEqual([{
      requestId: "request-1",
      messages: [{
        id: "user-1",
        role: "user",
        content: "hello",
        createdAt: 10,
      }],
      thinking: true,
      thinkingEffort: "high",
    }]);
    expect(chunks).toContainEqual({
      type: "text-delta",
      id: "request-1:text:1",
      delta: "right",
    });
    expect(JSON.stringify(chunks)).not.toContain("wrong");
    expect(chunks.at(-1)).toEqual({
      type: "finish",
      messageMetadata: {
        contextUsage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
      },
    });
    expect(api.listenerCount).toBe(0);
  });

  it("keeps continuation instructions request-only and targets the existing assistant", async () => {
    const api = new FakeChatApi();
    const ids = ["request-continue", "hidden-user"];
    const transport = new ElectronChatTransport(api, {
      createId: () => ids.shift() ?? "unexpected",
      now: () => 200,
    });
    const assistant = chatMessageToDesktopUIMessage({
      id: "assistant-1",
      role: "assistant",
      content: "first half",
      createdAt: 20,
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-1",
      messageId: "assistant-1",
      messages: [assistant],
      abortSignal: undefined,
      body: { mode: "continue" },
    });
    api.emit({ requestId: "request-continue", type: "done" });
    const chunks = await readChunks(stream);

    expect(api.requests[0].messages).toEqual([
      {
        id: "assistant-1",
        role: "assistant",
        content: "first half",
        createdAt: 20,
      },
      {
        id: "hidden-user",
        role: "user",
        content: CONTINUATION_INSTRUCTION,
        createdAt: 200,
      },
    ]);
    expect(chunks[0]).toEqual({
      type: "start",
      messageMetadata: { createdAt: 20, requestId: "request-continue" },
    });
  });

  it("maps warnings, ordered reasoning/text segments, approvals, and tool results", async () => {
    const api = new FakeChatApi();
    const transport = new ElectronChatTransport(api, {
      createId: () => "request-tools",
      now: () => 300,
    });
    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-tools",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    api.emit({ requestId: "request-tools", type: "warning", message: "tool budget" });
    api.emit({ requestId: "request-tools", type: "reasoning", text: "think" });
    api.emit({ requestId: "request-tools", type: "delta", text: "before" });
    api.emit({
      requestId: "request-tools",
      type: "tool-call",
      call: {
        id: "call-1",
        name: "write_file",
        displayName: "写入文件",
        arguments: "{\"path\":\"a.txt\"}",
        status: "pending-approval",
        requiresApproval: true,
      },
    });
    api.emit({
      requestId: "request-tools",
      type: "tool-call",
      call: {
        id: "call-1",
        name: "write_file",
        displayName: "写入文件",
        arguments: "{\"path\":\"a.txt\"}",
        status: "running",
        requiresApproval: true,
      },
    });
    api.emit({
      requestId: "request-tools",
      type: "tool-result",
      toolCallId: "call-1",
      status: "completed",
      result: "saved",
    });
    api.emit({ requestId: "request-tools", type: "delta", text: "after" });
    api.emit({ requestId: "request-tools", type: "done" });
    const chunks = await readChunks(stream);

    expect(chunks).toContainEqual({
      type: "data-warning",
      id: "request-tools:warning:1",
      data: { requestId: "request-tools", message: "tool budget" },
      transient: true,
    });
    expect(chunks).toContainEqual({
      type: "tool-approval-request",
      approvalId: "request-tools:call-1",
      toolCallId: "call-1",
    });
    expect(chunks.filter((chunk) => chunk.type === "tool-input-available")).toHaveLength(1);
    expect(chunks).toContainEqual({
      type: "tool-output-available",
      toolCallId: "call-1",
      output: "saved",
      dynamic: true,
    });
    expect(chunks).toContainEqual({
      type: "data-tool-result",
      id: "call-1",
      data: {
        toolCallId: "call-1",
        status: "completed",
        resultPresent: true,
        errorPresent: false,
        result: "saved",
      },
    });
    expect(chunkIndex(chunks, "reasoning-end")).toBeLessThan(
      chunkIndex(chunks, "text-start"),
    );
    expect(chunkIndex(chunks, "text-end")).toBeLessThan(
      chunkIndex(chunks, "tool-input-available"),
    );
    const textStarts = chunks.filter((chunk) => chunk.type === "text-start");
    expect(textStarts).toHaveLength(2);
  });

  it("maps denied and failed tool results without losing diagnostic text", async () => {
    const api = new FakeChatApi();
    const transport = new ElectronChatTransport(api, {
      createId: () => "request-terminal-tools",
    });
    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-tools",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });
    for (const [id, status] of [["denied", "denied"], ["failed", "error"]] as const) {
      api.emit({
        requestId: "request-terminal-tools",
        type: "tool-call",
        call: {
          id,
          name: id,
          displayName: id,
          arguments: "{}",
          status: "running",
          requiresApproval: status === "denied",
        },
      });
      api.emit({
        requestId: "request-terminal-tools",
        type: "tool-result",
        toolCallId: id,
        status,
        ...(status === "denied" ? { result: "not allowed" } : { error: "failed hard" }),
      });
    }
    api.emit({ requestId: "request-terminal-tools", type: "done" });
    const chunks = await readChunks(stream);

    expect(chunks).toContainEqual({ type: "tool-output-denied", toolCallId: "denied" });
    expect(chunks).toContainEqual({
      type: "tool-output-error",
      toolCallId: "failed",
      errorText: "failed hard",
      dynamic: true,
    });
    expect(chunks).toContainEqual(expect.objectContaining({
      type: "data-tool-result",
      id: "denied",
      data: expect.objectContaining({ result: "not allowed" }),
    }));
  });

  it("aborts the backend once for an AbortSignal and closes the stream", async () => {
    const api = new FakeChatApi();
    const controller = new AbortController();
    const transport = new ElectronChatTransport(api, {
      createId: () => "request-abort",
    });
    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-abort",
      messageId: undefined,
      messages: [],
      abortSignal: controller.signal,
    });

    controller.abort();
    controller.abort();
    const chunks = await readChunks(stream);

    expect(api.aborts).toEqual(["request-abort"]);
    expect(chunks.at(-1)).toEqual({ type: "abort", reason: "已停止生成" });
    expect(api.listenerCount).toBe(0);
  });

  it("aborts the backend once when a reader cancels directly", async () => {
    const api = new FakeChatApi();
    const transport = new ElectronChatTransport(api, {
      createId: () => "request-cancel",
    });
    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-cancel",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    await stream.cancel("no longer needed");
    await stream.cancel("still cancelled");

    expect(api.aborts).toEqual(["request-cancel"]);
    expect(api.listenerCount).toBe(0);
  });

  it("maps runtime errors and does not support stream reconnection", async () => {
    const api = new FakeChatApi();
    const transport = new ElectronChatTransport(api, {
      createId: () => "request-error",
    });
    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-error",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });
    api.emit({
      requestId: "request-error",
      type: "tool-call",
      call: {
        id: "active-tool",
        name: "active_tool",
        displayName: "Active Tool",
        arguments: "{}",
        status: "running",
        requiresApproval: false,
      },
    });
    api.emit({ requestId: "request-error", type: "error", message: "model failed" });

    const chunks = await readChunks(stream);
    expect(chunks).toContainEqual({
      type: "tool-output-error",
      toolCallId: "active-tool",
      errorText: "任务因生成错误而终止：model failed",
      dynamic: true,
    });
    expect(chunks).toContainEqual({
      type: "error",
      errorText: "model failed",
    });
    expect(await transport.reconnectToStream({
      chatId: "chat-error",
      abortSignal: undefined,
    })).toBeNull();
  });
});

async function readChunks(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  const reader = stream.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) return chunks;
    chunks.push(next.value);
  }
}

function chunkIndex(chunks: UIMessageChunk[], type: UIMessageChunk["type"]): number {
  return chunks.findIndex((chunk) => chunk.type === type);
}
