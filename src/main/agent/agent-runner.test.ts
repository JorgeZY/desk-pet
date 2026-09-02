import { dynamicTool, jsonSchema } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "../../shared/types";
import { DEFAULT_CONFIG } from "../config-store";
import { agentInstructions, AgentRunner } from "./agent-runner";
import type { createLlamaModelAdapter } from "./llama-model-adapter";
import type { AgentToolDescriptor } from "./tool-provider";
import {
  DIAGNOSTIC_TEXT_BYTE_LIMIT,
  toolResultPromptByteBudget,
  utf8ByteLength,
} from "./tool-result-budget";

afterEach(() => vi.restoreAllMocks());

const usage = (input: number, output: number) => ({
  inputTokens: {
    total: input,
    noCache: input,
    cacheRead: 0,
    cacheWrite: 0,
  },
  outputTokens: {
    total: output,
    text: output,
    reasoning: 0,
  },
});

const finishReason = (unified: "stop" | "tool-calls", raw = unified) => ({ unified, raw });

function modelStream(chunks: unknown[]) {
  return { stream: simulateReadableStream({ chunks, chunkDelayInMs: null }) };
}

function descriptor(
  name: string,
  execute: (input: unknown, options: { abortSignal?: AbortSignal }) => unknown,
  requiresApproval = false,
): AgentToolDescriptor {
  return {
    name,
    displayName: name,
    source: "builtin",
    requiresApproval,
    tool: dynamicTool({
      inputSchema: jsonSchema({ type: "object", properties: {} }),
      execute,
    }),
  };
}

function adapterFactory(model: MockLanguageModelV4): typeof createLlamaModelAdapter {
  return (() => ({
    model,
    settings: {
      maxOutputTokens: 64,
      temperature: 0.2,
      topP: 0.9,
      presencePenalty: 0,
      maxRetries: 0,
    },
  })) as typeof createLlamaModelAdapter;
}

async function run(
  model: MockLanguageModelV4,
  tools: AgentToolDescriptor[],
  waitForApproval = vi.fn(async () => true),
) {
  const events: ChatEvent[] = [];
  const runner = new AgentRunner({
    config: DEFAULT_CONFIG,
    endpoint: "http://127.0.0.1:1234",
    tools,
    waitForApproval,
    createModelAdapter: adapterFactory(model),
  });
  await runner.run({
    request: {
      requestId: "request-1",
      messages: [],
      thinking: false,
      thinkingEffort: "medium",
    },
    messages: [{ role: "user", content: "run tools" }],
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
  });
  return events;
}

describe("AgentRunner", () => {
  it("adds compact prompt-injection guidance only when local knowledge is available", () => {
    const knowledge = descriptor("search_local_knowledge", async () => "result");
    knowledge.source = "knowledge";
    expect(agentInstructions("system", [knowledge])).toContain("不可信的参考数据");
    expect(agentInstructions("system", [])).toBe("system");
  });

  it("serializes multiple tool calls from the same model step", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        modelStream([
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "call-a", toolName: "tool_a", input: "{}" },
          { type: "tool-call", toolCallId: "call-b", toolName: "tool_b", input: "{}" },
          { type: "finish", finishReason: finishReason("tool-calls"), usage: usage(8, 2) },
        ]),
        modelStream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "text-1" },
          { type: "text-delta", id: "text-1", delta: "done" },
          { type: "text-end", id: "text-1" },
          { type: "finish", finishReason: finishReason("stop"), usage: usage(12, 1) },
        ]),
      ],
    });
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const tool = (name: string) => descriptor(name, async () => {
      order.push(`${name}:start`);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, name === "tool_a" ? 10 : 0));
      active -= 1;
      order.push(`${name}:end`);
      return `${name}:result`;
    });

    const events = await run(model, [tool("tool_a"), tool("tool_b")]);

    expect(maxActive).toBe(1);
    expect(order).toEqual([
      "tool_a:start",
      "tool_a:end",
      "tool_b:start",
      "tool_b:end",
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "tool-call",
      "tool-result",
      "tool-call",
      "tool-result",
      "delta",
      "done",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      contextUsage: { promptTokens: 12, completionTokens: 1, totalTokens: 13 },
    });
  });

  it("returns a denial to the model without executing the tool", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        modelStream([
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "call-write", toolName: "write_file", input: "{}" },
          { type: "finish", finishReason: finishReason("tool-calls"), usage: usage(5, 1) },
        ]),
        modelStream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "text-2" },
          { type: "text-delta", id: "text-2", delta: "cancelled" },
          { type: "text-end", id: "text-2" },
          { type: "finish", finishReason: finishReason("stop"), usage: usage(7, 1) },
        ]),
      ],
    });
    const execute = vi.fn(async () => "written");
    const waitForApproval = vi.fn(async () => false);

    const events = await run(
      model,
      [descriptor("write_file", execute, true)],
      waitForApproval,
    );

    expect(waitForApproval).toHaveBeenCalledWith("call-write", expect.any(AbortSignal));
    expect(execute).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      type: "tool-call",
      call: { id: "call-write", status: "pending-approval" },
    });
    expect(events[1]).toMatchObject({
      type: "tool-result",
      toolCallId: "call-write",
      status: "denied",
    });
  });

  it("maps MCP protocol errors to an error event and lets the loop recover", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        modelStream([
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "call-mcp", toolName: "mcp__docs__read", input: "{}" },
          { type: "finish", finishReason: finishReason("tool-calls"), usage: usage(5, 1) },
        ]),
        modelStream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "text-3" },
          { type: "text-delta", id: "text-3", delta: "recovered" },
          { type: "text-end", id: "text-3" },
          { type: "finish", finishReason: finishReason("stop"), usage: usage(8, 1) },
        ]),
      ],
    });
    const mcpTool = descriptor("mcp__docs__read", async () => ({
      isError: true,
      content: [{ type: "text", text: "document missing" }],
    }));
    mcpTool.source = "mcp";

    const events = await run(model, [mcpTool]);

    expect(events).toContainEqual(expect.objectContaining({
      type: "tool-result",
      toolCallId: "call-mcp",
      status: "error",
      error: "document missing",
    }));
    expect(events).toContainEqual(expect.objectContaining({ type: "delta", text: "recovered" }));
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("bounds a thrown tool diagnostic before IPC and persistence", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        modelStream([
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "call-error", toolName: "bad_remote", input: "{}" },
          { type: "finish", finishReason: finishReason("tool-calls"), usage: usage(5, 1) },
        ]),
        modelStream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "text-error" },
          { type: "text-delta", id: "text-error", delta: "recovered" },
          { type: "text-end", id: "text-error" },
          { type: "finish", finishReason: finishReason("stop"), usage: usage(8, 1) },
        ]),
      ],
    });
    const events = await run(model, [descriptor("bad_remote", async () => {
      throw new Error("坏".repeat(100_000));
    })]);
    const result = events.find((event) => event.type === "tool-result");

    expect(result).toMatchObject({ status: "error" });
    if (!result || result.type !== "tool-result" || typeof result.error !== "string") {
      throw new Error("missing tool error event");
    }
    expect(result.error).toContain("[诊断信息过长，已截断]");
    expect(utf8ByteLength(result.error)).toBeLessThanOrEqual(DIAGNOSTIC_TEXT_BYTE_LIMIT);
  });

  it("caps one tool result to the configured local context budget", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        modelStream([
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "call-large", toolName: "read_large", input: "{}" },
          { type: "finish", finishReason: finishReason("tool-calls"), usage: usage(5, 1) },
        ]),
        modelStream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "text-large" },
          { type: "text-delta", id: "text-large", delta: "done" },
          { type: "text-end", id: "text-large" },
          { type: "finish", finishReason: finishReason("stop"), usage: usage(8, 1) },
        ]),
      ],
    });

    const events = await run(model, [descriptor("read_large", async () => "你".repeat(10_000))]);
    const result = events.find((event) => event.type === "tool-result");

    expect(result).toMatchObject({ status: "completed" });
    if (!result || result.type !== "tool-result" || typeof result.result !== "string") {
      throw new Error("missing completed tool result");
    }
    expect(result.result).toContain("[工具结果过长，已截断]");
    expect(utf8ByteLength(result.result))
      .toBeLessThanOrEqual(toolResultPromptByteBudget(DEFAULT_CONFIG));
  });

  it("reclaims the shared budget after pruning older historical tool rounds", async () => {
    const model = new MockLanguageModelV4({
      doStream: modelStream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "text-history" },
        { type: "text-delta", id: "text-history", delta: "done" },
        { type: "text-end", id: "text-history" },
        { type: "finish", finishReason: finishReason("stop"), usage: usage(8, 1) },
      ]),
    });
    const rounds = ["old", "middle", "new"].flatMap((id) => ([
      {
        role: "assistant" as const,
        content: [{
          type: "tool-call" as const,
          toolCallId: `call-${id}`,
          toolName: "read_large",
          input: { id },
        }],
      },
      {
        role: "tool" as const,
        content: [{
          type: "tool-result" as const,
          toolCallId: `call-${id}`,
          toolName: "read_large",
          output: { type: "text" as const, value: id.repeat(10_000) },
        }],
      },
    ]));
    const runner = new AgentRunner({
      config: DEFAULT_CONFIG,
      endpoint: "http://127.0.0.1:1234",
      tools: [],
      waitForApproval: async () => true,
      createModelAdapter: adapterFactory(model),
    });

    await runner.run({
      request: {
        requestId: "history-budget",
        messages: [],
        thinking: false,
        thinkingEffort: "medium",
      },
      messages: [
        { role: "user", content: "start" },
        ...rounds,
        { role: "user", content: "continue" },
      ],
      signal: new AbortController().signal,
      emit: () => undefined,
    });

    const prompt = JSON.stringify(model.doStreamCalls[0].prompt);
    const promptToolBytes = model.doStreamCalls[0].prompt.reduce((total, message) => {
      if (message.role !== "tool") return total;
      return total + message.content.reduce((partTotal, part) => part.type === "tool-result"
        && part.output.type === "text"
        ? partTotal + utf8ByteLength(part.output.value)
        : partTotal, 0);
    }, 0);
    expect(prompt).not.toContain("call-old");
    expect(prompt).toContain("call-middle");
    expect(prompt).toContain("call-new");
    expect(promptToolBytes).toBeLessThanOrEqual(toolResultPromptByteBudget(DEFAULT_CONFIG));
    expect(promptToolBytes).toBeGreaterThan(2_000);
  });

  it("reports an invalid tool call once and does not execute registered tools", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const model = new MockLanguageModelV4({
      doStream: modelStream([
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: "call-missing", toolName: "missing_tool", input: "{}" },
        { type: "finish", finishReason: finishReason("tool-calls"), usage: usage(3, 1) },
      ]),
    });
    const execute = vi.fn(async () => "unused");
    const events: ChatEvent[] = [];
    const runner = new AgentRunner({
      config: DEFAULT_CONFIG,
      endpoint: "http://127.0.0.1:1234",
      tools: [descriptor("known_tool", execute)],
      waitForApproval: async () => true,
      createModelAdapter: adapterFactory(model),
    });

    await expect(runner.run({
      request: {
        requestId: "invalid-request",
        messages: [],
        thinking: false,
        thinkingEffort: "medium",
      },
      messages: [{ role: "user", content: "call missing tool" }],
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    })).rejects.toThrow();

    expect(execute).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === "tool-call")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool-result")).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tool-call",
      call: { id: "call-missing", status: "error" },
    });
    consoleError.mockRestore();
  });

  it("aborts an approval wait and never starts the queued tools", async () => {
    const model = new MockLanguageModelV4({
      doStream: modelStream([
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: "call-a", toolName: "tool_a", input: "{}" },
        { type: "tool-call", toolCallId: "call-b", toolName: "tool_b", input: "{}" },
        { type: "finish", finishReason: finishReason("tool-calls"), usage: usage(5, 1) },
      ]),
    });
    const execute = vi.fn(async () => "unused");
    let approvalStarted!: () => void;
    const approvalPending = new Promise<void>((resolve) => { approvalStarted = resolve; });
    const waitForApproval = vi.fn((_toolCallId: string, signal: AbortSignal) => {
      approvalStarted();
      return new Promise<boolean>((resolve) => {
        signal.addEventListener("abort", () => resolve(false), { once: true });
      });
    });
    const controller = new AbortController();
    const events: ChatEvent[] = [];
    const runner = new AgentRunner({
      config: DEFAULT_CONFIG,
      endpoint: "http://127.0.0.1:1234",
      tools: [
        descriptor("tool_a", execute, true),
        descriptor("tool_b", execute, true),
      ],
      waitForApproval,
      createModelAdapter: adapterFactory(model),
    });
    const result = runner.run({
      request: {
        requestId: "abort-request",
        messages: [],
        thinking: false,
        thinkingEffort: "medium",
      },
      messages: [{ role: "user", content: "run both" }],
      signal: controller.signal,
      emit: (event) => events.push(event),
    });

    await approvalPending;
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });

    expect(waitForApproval).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === "tool-call")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool-result")).toHaveLength(0);
  });
});
