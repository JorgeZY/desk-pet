import { describe, expect, it, vi } from "vitest";
import {
  ContextBudgetExceededError,
  createExactContextBudgetFetch,
  ExactTokenCounterError,
  fitRequestToContext,
  probeExactTokenCounter,
} from "./exact-context-budget";

const messageTokens = (body: Record<string, unknown>): number => JSON.stringify(body.messages).length;

describe("fitRequestToContext", () => {
  it("keeps a request that exactly matches the input budget", async () => {
    const body = { messages: [{ role: "user", content: "hello" }] };
    const tokens = messageTokens(body);
    const result = await fitRequestToContext({
      body,
      inputBudget: tokens,
      count: async (candidate) => messageTokens(candidate),
    });
    expect(result).toEqual({ body, omittedTurns: 0, documentsTruncated: false });
  });

  it("drops complete old turns without orphaning tool messages", async () => {
    const body = {
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "old question" },
        { role: "assistant", content: null, tool_calls: [{ id: "old-call" }] },
        { role: "tool", tool_call_id: "old-call", content: "old result" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "current question" },
      ],
    };
    const latest = {
      ...body,
      messages: [body.messages[0], body.messages.at(-1)!],
    };
    const result = await fitRequestToContext({
      body,
      inputBudget: messageTokens(latest),
      count: async (candidate) => messageTokens(candidate),
    });
    expect(result.omittedTurns).toBe(1);
    expect(result.body.messages).toEqual(latest.messages);
  });

  it("truncates generated document parts before rejecting the current prompt", async () => {
    const body = {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "summarize" },
          { type: "text", text: `<document name="a.txt">\n${"x".repeat(500)}\n</document>` },
        ],
      }],
    };
    const core = {
      messages: [{ role: "user", content: [{ type: "text", text: "summarize" }] }],
    };
    const result = await fitRequestToContext({
      body,
      inputBudget: messageTokens(core) + 120,
      count: async (candidate) => messageTokens(candidate),
    });
    expect(result.documentsTruncated).toBe(true);
    expect(messageTokens(result.body)).toBeLessThanOrEqual(messageTokens(core) + 120);
  });

  it("rejects a current prompt that cannot fit without documents", async () => {
    const body = { messages: [{ role: "user", content: "x".repeat(300) }] };
    await expect(fitRequestToContext({
      body,
      inputBudget: 50,
      count: async (candidate) => messageTokens(candidate),
    })).rejects.toBeInstanceOf(ContextBudgetExceededError);
  });
});

describe("createExactContextBudgetFetch", () => {
  it("counts the final AI SDK body and sends the fitted request", async () => {
    const warnings: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url.endsWith("/input_tokens")) {
        return Response.json({ input_tokens: messageTokens(body) });
      }
      return new Response("ok", { status: 200 });
    });
    const budgetFetch = createExactContextBudgetFetch({
      contextSize: 180,
      maxOutputTokens: 50,
      fetch: fetchMock,
      onWarning: (warning) => warnings.push(warning),
    });

    await budgetFetch("http://127.0.0.1:1234/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "old".repeat(30) },
          { role: "assistant", content: "answer" },
          { role: "user", content: "current" },
        ],
      }),
    });

    const actualCall = fetchMock.mock.calls.at(-1)!;
    const actualBody = JSON.parse(String(actualCall[1]?.body)) as { messages: unknown[] };
    expect(String(actualCall[0]).endsWith("/chat/completions")).toBe(true);
    expect(actualBody.messages).toEqual([{ role: "user", content: "current" }]);
    expect(warnings).toHaveLength(1);
  });
});

describe("probeExactTokenCounter", () => {
  it("accepts a valid input_tokens response", async () => {
    const fetchMock = vi.fn(async () => Response.json({ input_tokens: 4 }));
    await expect(probeExactTokenCounter("http://127.0.0.1:1234", { fetch: fetchMock }))
      .resolves.toBeUndefined();
  });

  it("rejects unsupported and malformed token counters", async () => {
    await expect(probeExactTokenCounter("http://127.0.0.1:1234", {
      fetch: async () => new Response("missing", { status: 404 }),
    })).rejects.toBeInstanceOf(ExactTokenCounterError);
    await expect(probeExactTokenCounter("http://127.0.0.1:1234", {
      fetch: async () => Response.json({ tokens: 2 }),
    })).rejects.toThrow("input_tokens");
  });

  it("honors an already aborted parent signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(probeExactTokenCounter("http://127.0.0.1:1234", {
      signal: controller.signal,
      fetch: async (_input, init) => {
        init?.signal?.throwIfAborted();
        return Response.json({ input_tokens: 1 });
      },
    })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fails when the exact counter times out", async () => {
    await expect(probeExactTokenCounter("http://127.0.0.1:1234", {
      timeoutMs: 10,
      fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
    })).rejects.toThrow("无法访问 llama.cpp 精确 token 计数接口");
  });
});
