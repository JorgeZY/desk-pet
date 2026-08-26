import { describe, expect, it, vi } from "vitest";
import { LlamaToolProvider, toChatToolDefinitions } from "./llama-tool-provider";

describe("LlamaToolProvider", () => {
  it("discovers builtin tools, filters MCP duplicates, and executes a tool", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) {
        return Response.json([
          {
            tool: "read_file",
            display_name: "Read file",
            permissions: { write: false },
            definition: {
              type: "function",
              function: {
                name: "read_file",
                description: "Read a file",
                parameters: {
                  type: "object",
                  properties: { path: { type: "string" } },
                  required: ["path"],
                },
              },
            },
          },
          {
            type: "mcp",
            tool: "legacy_mcp_tool",
            definition: { name: "legacy_mcp_tool", parameters: { type: "object" } },
          },
        ]);
      }
      expect(String(input)).toBe("http://127.0.0.1:1234/tools");
      expect(JSON.parse(String(init.body))).toEqual({
        tool: "read_file",
        params: { path: "notes.txt" },
      });
      return Response.json({ plain_text_response: "contents" });
    });
    const provider = new LlamaToolProvider({
      endpoint: "http://127.0.0.1:1234/",
      cwd: "D:\\project",
      fetch: fetchMock,
    });

    await provider.start();
    const descriptors = provider.getDescriptors();
    expect(toChatToolDefinitions(descriptors)).toEqual([{
      id: "read_file",
      displayName: "Read file",
      source: "builtin",
      requiresApproval: false,
    }]);
    const execute = descriptors[0]?.tool.execute;
    expect(execute).toBeTypeOf("function");
    await expect(execute?.(
      { path: "notes.txt" },
      { toolCallId: "call-1", messages: [], context: undefined },
    )).resolves.toBe("contents");
  });

  it("treats a missing tools endpoint as an empty catalog", async () => {
    const provider = new LlamaToolProvider({
      endpoint: "http://127.0.0.1:1234",
      fetch: vi.fn(async () => new Response("missing", { status: 404 })),
    });
    await provider.start();
    expect(provider.getDescriptors()).toEqual([]);
  });

  it("requires approval when builtin permission metadata is missing", async () => {
    const provider = new LlamaToolProvider({
      endpoint: "http://127.0.0.1:1234",
      fetch: vi.fn(async () => Response.json([{
        tool: "unknown_side_effect",
        display_name: "Unknown side effect",
        definition: {
          type: "function",
          function: {
            name: "unknown_side_effect",
            parameters: { type: "object", properties: {} },
          },
        },
      }])),
    });

    await provider.start();
    expect(provider.getDescriptors()[0]?.requiresApproval).toBe(true);
  });

  it("bounds discovery even when fetch ignores abort", async () => {
    vi.useFakeTimers();
    try {
      const provider = new LlamaToolProvider({
        endpoint: "http://127.0.0.1:1234",
        discoveryTimeoutMs: 25,
        fetch: vi.fn(() => new Promise<Response>(() => undefined)),
      });

      const start = expect(provider.start()).rejects.toThrow("GET /tools 在 25 ms 内未响应");
      await vi.advanceTimersByTimeAsync(25);
      await start;
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the discovery timeout active while reading the response body", async () => {
    vi.useFakeTimers();
    try {
      const provider = new LlamaToolProvider({
        endpoint: "http://127.0.0.1:1234",
        discoveryTimeoutMs: 25,
        fetch: vi.fn(async () => ({
          status: 200,
          ok: true,
          json: () => new Promise<unknown>(() => undefined),
        }) as Response),
      });

      const start = expect(provider.start()).rejects.toThrow("GET /tools 在 25 ms 内未响应");
      await vi.advanceTimersByTimeAsync(25);
      await start;
    } finally {
      vi.useRealTimers();
    }
  });
});
