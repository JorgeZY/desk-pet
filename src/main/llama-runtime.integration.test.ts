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
      if (request.url === "/v1/chat/completions") {
        requestPayload = JSON.parse(await readBody(request)) as Record<string, unknown>;
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        response.write(
          'data: {"choices":[{"delta":{"reasoning_content":"先想一想"}}]}\n\n',
        );
        response.write('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n');
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
      chat_template_kwargs: { enable_thinking: true },
    });
  });

});
