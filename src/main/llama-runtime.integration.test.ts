import { createServer, type IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./config-store";
import { LlamaRuntime } from "./llama-runtime";
import type { ChatEvent } from "../shared/types";

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};

describe("LlamaRuntime local HTTP integration", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  it("connects to a healthy server and translates OpenAI SSE chunks", async () => {
    let requestPayload: Record<string, unknown> | undefined;
    const server = createServer(async (request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"status":"ok"}');
        return;
      }
      if (request.url === "/tools" && request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify([{
          tool: "read_file",
          display_name: "Read file",
          permissions: { write: false },
          definition: {
            type: "function",
            function: {
              name: "read_file",
              description: "Read a local file",
              parameters: { type: "object", properties: {} },
            },
          },
        }]));
        return;
      }
      if (request.url === "/v1/chat/completions/input_tokens") {
        await readBody(request);
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"input_tokens":32}');
        return;
      }
      if (request.url === "/v1/chat/completions") {
        requestPayload = JSON.parse(await readBody(request)) as Record<string, unknown>;
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        response.write(
          'data: {"id":"chatcmpl-1","created":1,"model":"desk-pet-model","choices":[{"delta":{"role":"assistant","reasoning_content":"先想一想"},"finish_reason":null}]}\n\n',
        );
        response.write('data: {"id":"chatcmpl-1","created":1,"model":"desk-pet-model","choices":[{"delta":{"content":"你好"},"finish_reason":null}]}\n\n');
        response.write('data: {"id":"chatcmpl-1","created":1,"model":"desk-pet-model","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}\n\n');
        response.end("data: [DONE]\n\n");
        return;
      }
      response.writeHead(404);
      response.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server port");

    const runtime = new LlamaRuntime({
      ...DEFAULT_CONFIG,
      port: address.port,
    });
    cleanups.push(async () => {
      await runtime.stop();
    });

    expect((await runtime.start()).phase).toBe("ready");
    expect(runtime.snapshot.externallyManaged).toBe(true);

    const events: ChatEvent[] = [];
    await runtime.streamChat(
      {
        requestId: "integration-request",
        thinking: true,
        thinkingEffort: "medium",
        messages: [
          {
            id: "user-message",
            role: "user",
            content: "打个招呼",
            createdAt: Date.now(),
          },
        ],
      },
      (event) => events.push(event),
    );

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "reasoning",
      "delta",
      "done",
    ]);
    expect(events[1]).toMatchObject({ type: "reasoning", text: "先想一想" });
    expect(events[2]).toMatchObject({ type: "delta", text: "你好" });
    expect(requestPayload).toMatchObject({
      model: "desk-pet-model",
      stream: true,
      temperature: DEFAULT_CONFIG.temperature,
      top_k: DEFAULT_CONFIG.topK,
      top_p: DEFAULT_CONFIG.topP,
      min_p: DEFAULT_CONFIG.minP,
      repeat_penalty: DEFAULT_CONFIG.repeatPenalty,
      presence_penalty: DEFAULT_CONFIG.presencePenalty,
      reasoning_effort: "medium",
      thinking_budget_tokens: 256,
      chat_template_kwargs: { enable_thinking: true, reasoning_effort: "medium" },
      parallel_tool_calls: false,
    });
  });

  it("runs a streamed builtin tool call and continues to the final answer", async () => {
    let completionCount = 0;
    let tokenCountRequests = 0;
    let toolPayload: Record<string, unknown> | undefined;
    const server = createServer(async (request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"status":"ok"}');
        return;
      }
      if (request.url === "/tools" && request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify([{
          tool: "read_file",
          display_name: "读取文件",
          permissions: { write: false },
          definition: {
            type: "function",
            function: {
              name: "read_file",
              description: "Read a local file",
              parameters: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
              },
            },
          },
        }]));
        return;
      }
      if (request.url === "/tools" && request.method === "POST") {
        toolPayload = JSON.parse(await readBody(request)) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ plain_text_response: "文件里的内容" }));
        return;
      }
      if (request.url === "/v1/chat/completions/input_tokens") {
        tokenCountRequests += 1;
        await readBody(request);
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"input_tokens":48}');
        return;
      }
      if (request.url === "/v1/chat/completions") {
        completionCount += 1;
        const body = JSON.parse(await readBody(request)) as { messages?: unknown[] };
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (completionCount === 1) {
          response.write('data: {"id":"chatcmpl-tool","created":1,"model":"desk-pet-model","choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":"}}]},"finish_reason":null}]}\n\n');
          response.write('data: {"id":"chatcmpl-tool","created":1,"model":"desk-pet-model","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"notes.txt\\"}"}}]},"finish_reason":null}]}\n\n');
          response.write('data: {"id":"chatcmpl-tool","created":1,"model":"desk-pet-model","choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
          response.end("data: [DONE]\n\n");
        } else {
          expect(body.messages?.at(-1)).toEqual({
            role: "tool",
            content: "文件里的内容",
            tool_call_id: "call-1",
          });
          response.write('data: {"id":"chatcmpl-final","created":2,"model":"desk-pet-model","choices":[{"delta":{"role":"assistant","content":"已经读取完成"},"finish_reason":null}]}\n\n');
          response.write('data: {"id":"chatcmpl-final","created":2,"model":"desk-pet-model","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":14,"completion_tokens":3,"total_tokens":17}}\n\n');
          response.end("data: [DONE]\n\n");
        }
        return;
      }
      response.writeHead(404);
      response.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server port");
    const runtime = new LlamaRuntime({ ...DEFAULT_CONFIG, port: address.port });
    cleanups.push(async () => { await runtime.stop(); });
    expect((await runtime.start()).phase).toBe("ready");

    const events: ChatEvent[] = [];
    await runtime.streamChat({
      requestId: "tool-request",
      thinking: false,
      thinkingEffort: "medium",
      messages: [{
        id: "user-message",
        role: "user",
        content: "读取 notes.txt",
        createdAt: 1,
      }],
    }, (event) => events.push(event));

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "tool-call",
      "tool-result",
      "delta",
      "done",
    ]);
    expect(events[1]).toMatchObject({
      type: "tool-call",
      call: { id: "call-1", name: "read_file", status: "running" },
    });
    expect(events[2]).toMatchObject({
      type: "tool-result",
      toolCallId: "call-1",
      status: "completed",
      result: "文件里的内容",
    });
    expect(toolPayload).toEqual({ tool: "read_file", params: { path: "notes.txt" } });
    expect(completionCount).toBe(2);
    expect(tokenCountRequests).toBe(3);
  });

});
