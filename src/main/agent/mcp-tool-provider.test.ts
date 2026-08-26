import type {
  ListToolsResult,
  MCPClient,
  MCPClientConfig,
  MCPTransport,
} from "@ai-sdk/mcp";
import type { ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  classifyMcpToolApproval,
  createMcpAgentToolName,
  McpToolProvider,
  normalizeStdioConfig,
  type McpStdioTransportConfig,
} from "./mcp-tool-provider";

function createTransport(): MCPTransport {
  return {
    start: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

function createAgentTool(label: string): ToolSet[string] {
  return {
    inputSchema: { jsonSchema: { type: "object", properties: {} } },
    execute: vi.fn(async () => label),
  } as unknown as ToolSet[string];
}

function createMockClient(
  pages: ListToolsResult[],
  tools: Record<string, ToolSet[string]>,
  onClose?: () => void,
): MCPClient {
  let page = 0;
  return {
    listTools: vi.fn(async () => pages[page++]),
    toolsFromDefinitions: vi.fn((definitions: ListToolsResult) => Object.fromEntries(
      definitions.tools.map((definition) => [definition.name, tools[definition.name]]),
    )),
    close: vi.fn(async () => onClose?.()),
  } as unknown as MCPClient;
}

function definition(
  name: string,
  annotations?: Record<string, unknown>,
): ListToolsResult["tools"][number] {
  return {
    name,
    title: `${name} title`,
    description: `${name} description`,
    inputSchema: { type: "object", properties: {} },
    annotations,
  } as ListToolsResult["tools"][number];
}

describe("McpToolProvider", () => {
  it("loads Cursor stdio and HTTP configs as prefixed AI SDK tools", async () => {
    const readTool = createAgentTool("read");
    const writeTool = createAgentTool("write");
    const localClient = createMockClient([
      { tools: [definition("read.file", { readOnlyHint: true })] },
    ], { "read.file": readTool });
    const remoteClient = createMockClient([
      { tools: [definition("write-file")] },
    ], { "write-file": writeTool });
    const clients = [localClient, remoteClient];
    const clientConfigs: MCPClientConfig[] = [];
    const stdioConfigs: McpStdioTransportConfig[] = [];
    const stdioTransport = createTransport();

    const provider = McpToolProvider.fromConfigContents(JSON.stringify({
      mcpServers: {
        "Local Server": {
          command: "npx",
          args: ["-y", "local-mcp"],
          env: { LOCAL_TOKEN: "local-secret" },
          cwd: "D:\\tools",
        },
        Remote: {
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: "Bearer ${REMOTE_TOKEN}" },
          env: { REMOTE_TOKEN: "remote-secret" },
        },
      },
    }), {}, {
      createStdioTransport: (config) => {
        stdioConfigs.push(config);
        return stdioTransport;
      },
      createClient: async (config) => {
        clientConfigs.push(config);
        return clients.shift()!;
      },
      processEnv: { PATH: "inherited-path" },
    });

    await provider.start();

    expect(stdioConfigs).toEqual([{
      command: "npx",
      args: ["-y", "local-mcp"],
      env: { PATH: "inherited-path", LOCAL_TOKEN: "local-secret" },
      cwd: "D:\\tools",
      stderr: "inherit",
    }]);
    expect(clientConfigs[0]).toMatchObject({
      transport: stdioTransport,
      clientName: "desk-pet:Local Server",
      maxRetries: 0,
    });
    expect(clientConfigs[1].transport).toEqual({
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer remote-secret" },
      redirect: "error",
    });

    const descriptors = provider.getDescriptors();
    expect(descriptors.map(({ name, source, requiresApproval }) => ({
      name,
      source,
      requiresApproval,
    }))).toEqual([
      {
        name: "mcp__local_server__read_file",
        source: "mcp",
        requiresApproval: true,
      },
      {
        name: "mcp__remote__write-file",
        source: "mcp",
        requiresApproval: true,
      },
    ]);
    expect(descriptors[0].tool).toBe(readTool);
    expect(descriptors[1].tool).toBe(writeTool);
    expect(descriptors[1].metadata).toMatchObject({
      serverName: "Remote",
      originalName: "write-file",
      transport: "http",
      configuredTransport: "auto",
      approvalReason: "unclassified",
    });

    await provider.close();
    await provider.close();
    expect(localClient.close).toHaveBeenCalledOnce();
    expect(remoteClient.close).toHaveBeenCalledOnce();
    expect(provider.getDescriptors()).toEqual([]);
  });

  it("shares one close operation across concurrent callers", async () => {
    let releaseClose!: () => void;
    const client = createMockClient([{ tools: [] }], {});
    vi.mocked(client.close).mockImplementation(() =>
      new Promise<void>((resolve) => { releaseClose = resolve; }));
    const provider = McpToolProvider.fromConfigContents(JSON.stringify({
      mcpServers: { local: { command: "node" } },
    }), {}, {
      createStdioTransport: () => createTransport(),
      createClient: async () => client,
    });
    await provider.start();

    const first = provider.close();
    const second = provider.close();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(client.close).toHaveBeenCalledOnce());
    releaseClose();
    await Promise.all([first, second]);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("paginates tool discovery", async () => {
    const firstTool = createAgentTool("first");
    const secondTool = createAgentTool("second");
    const client = createMockClient([
      { tools: [definition("first")], nextCursor: "page-2" },
      { tools: [definition("second", { readOnlyHint: true })] },
    ], { first: firstTool, second: secondTool });
    const provider = McpToolProvider.fromConfigContents(JSON.stringify({
      mcpServers: { local: { command: "node", args: ["server.js"] } },
    }), {}, {
      createStdioTransport: () => createTransport(),
      createClient: async () => client,
    });

    await provider.start();

    expect(client.listTools).toHaveBeenNthCalledWith(2, {
      params: { cursor: "page-2" },
      options: expect.objectContaining({ timeout: 15_000 }),
    });
    expect(provider.getDescriptors()).toHaveLength(2);
    await provider.close();
  });

  it("rejects a repeated pagination cursor", async () => {
    const client = createMockClient([
      { tools: [], nextCursor: "same-page" },
      { tools: [], nextCursor: "same-page" },
    ], {});
    const provider = McpToolProvider.fromConfigContents(JSON.stringify({
      mcpServers: { local: { command: "node", args: ["server.js"] } },
    }), {}, {
      createStdioTransport: () => createTransport(),
      createClient: async () => client,
    });

    await expect(provider.start()).rejects.toThrow("repeated cursor");
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("bounds the number and serialized size of discovered tool definitions", async () => {
    const tooMany = Array.from({ length: 129 }, (_, index) => definition(`tool-${index}`));
    const tooManyClient = createMockClient([{ tools: tooMany }], {});
    const tooManyProvider = McpToolProvider.fromConfigContents(JSON.stringify({
      mcpServers: { local: { command: "node" } },
    }), {}, {
      createStdioTransport: () => createTransport(),
      createClient: async () => tooManyClient,
    });
    await expect(tooManyProvider.start()).rejects.toThrow("more than 128 tools");

    const oversized = definition("oversized") as ListToolsResult["tools"][number] & {
      description: string;
    };
    oversized.description = "x".repeat(1024 * 1024);
    const oversizedClient = createMockClient([{ tools: [oversized] }], {});
    const oversizedProvider = McpToolProvider.fromConfigContents(JSON.stringify({
      mcpServers: { local: { command: "node" } },
    }), {}, {
      createStdioTransport: () => createTransport(),
      createClient: async () => oversizedClient,
    });
    await expect(oversizedProvider.start()).rejects.toThrow("UTF-8 bytes");
  });

  it("falls back from auto HTTP to SSE only for an explicit incompatibility", async () => {
    const client = createMockClient(
      [{ tools: [definition("legacy-read")] }],
      { "legacy-read": createAgentTool("legacy") },
    );
    const clientConfigs: MCPClientConfig[] = [];
    const onServerStartError = vi.fn();
    const onUncaughtError = vi.fn();
    const httpError = Object.assign(
      new Error("This server does not support HTTP transport. Try using `sse` transport instead"),
      { statusCode: 404 },
    );
    const provider = McpToolProvider.fromConfigContents(JSON.stringify({
      mcpServers: { legacy: { url: "https://mcp.example.com/sse" } },
    }), { onServerStartError, onUncaughtError }, {
      createClient: async (config) => {
        clientConfigs.push(config);
        if ((config.transport as { type?: string }).type === "http") {
          config.onUncaughtError?.(httpError);
          throw httpError;
        }
        return client;
      },
    });

    await provider.start();

    expect(clientConfigs.map(({ transport }) => (transport as { type?: string }).type))
      .toEqual(["http", "sse"]);
    expect(provider.getDescriptors()[0].metadata).toMatchObject({
      transport: "sse",
      configuredTransport: "auto",
    });
    expect(onServerStartError).not.toHaveBeenCalled();
    expect(onUncaughtError).not.toHaveBeenCalled();
    await provider.close();
  });

  it("honors explicit remote transports without protocol fallback", async () => {
    const sseClient = createMockClient([{ tools: [] }], {});
    const sseCreateClient = vi.fn(async () => sseClient);
    const sseProvider = McpToolProvider.fromConfigContents(JSON.stringify({
      mcpServers: {
        legacy: { url: "https://mcp.example.com/sse", transport: "sse" },
      },
    }), {}, { createClient: sseCreateClient });
    await sseProvider.start();
    expect((sseCreateClient.mock.calls[0][0].transport as { type?: string }).type).toBe("sse");
    await sseProvider.close();

    const incompatible = Object.assign(new Error("method not allowed"), { statusCode: 405 });
    const httpCreateClient = vi.fn(async () => { throw incompatible; });
    const httpProvider = McpToolProvider.fromConfigContents(JSON.stringify({
      mcpServers: {
        streamable: { url: "https://mcp.example.com/mcp", transport: "http" },
      },
    }), {}, { createClient: httpCreateClient });
    await expect(httpProvider.start()).rejects.toThrow("every configured MCP server");
    expect(httpCreateClient).toHaveBeenCalledOnce();
  });

  it("does not turn a generic HTTP failure into an SSE probe", async () => {
    const notFound = Object.assign(new Error("endpoint not found"), { statusCode: 404 });
    const createClient = vi.fn(async () => { throw notFound; });
    const provider = McpToolProvider.fromConfigContents(JSON.stringify({
      mcpServers: { remote: { url: "https://mcp.example.com/missing" } },
    }), {}, { createClient });

    await expect(provider.start()).rejects.toThrow("every configured MCP server");
    expect(createClient).toHaveBeenCalledOnce();
  });

  it("isolates normalized name collisions to the conflicting server", async () => {
    const closed: string[] = [];
    const firstClient = createMockClient(
      [{ tools: [definition("read.file")] }],
      { "read.file": createAgentTool("first") },
      () => closed.push("first"),
    );
    const secondClient = createMockClient(
      [{ tools: [definition("read/file")] }],
      { "read/file": createAgentTool("second") },
      () => closed.push("second"),
    );
    const clients = [firstClient, secondClient];
    const provider = McpToolProvider.fromConfigContents(JSON.stringify({
      mcpServers: {
        Server: { command: "node", args: ["first.js"] },
        server: { command: "node", args: ["second.js"] },
      },
    }), {}, {
      createStdioTransport: () => createTransport(),
      createClient: async () => clients.shift()!,
    });

    await provider.start();
    expect(closed).toEqual(["second"]);
    expect(provider.getDescriptors().map(({ name }) => name))
      .toEqual(["mcp__server__read_file"]);
    await provider.close();
    expect(closed).toEqual(["second", "first"]);
  });

  it("keeps a healthy sibling when a later server fails discovery", async () => {
    const firstClient = createMockClient(
      [{ tools: [definition("ok")] }],
      { ok: createAgentTool("ok") },
    );
    const failingClient = createMockClient([], {});
    vi.mocked(failingClient.listTools).mockRejectedValueOnce(new Error("discovery failed"));
    const clients = [firstClient, failingClient];
    const onServerStartError = vi.fn();
    const provider = McpToolProvider.fromConfigContents(JSON.stringify({
      mcpServers: {
        first: { command: "node", args: ["first.js"] },
        second: { command: "node", args: ["second.js"] },
      },
    }), { onServerStartError }, {
      createStdioTransport: () => createTransport(),
      createClient: async () => clients.shift()!,
    });

    await provider.start();
    expect(provider.getDescriptors().map(({ name }) => name))
      .toEqual(["mcp__first__ok"]);
    expect(firstClient.close).not.toHaveBeenCalled();
    expect(failingClient.close).toHaveBeenCalledOnce();
    expect(onServerStartError).toHaveBeenCalledWith("second", expect.objectContaining({
      message: "discovery failed",
    }));
    await provider.close();
    expect(firstClient.close).toHaveBeenCalledOnce();
  });

  it("reports a clear aggregate error when every server fails", async () => {
    const onServerStartError = vi.fn();
    const provider = McpToolProvider.fromConfigContents(JSON.stringify({
      mcpServers: {
        first: { command: "node", args: ["first.js"] },
        second: { command: "node", args: ["second.js"] },
      },
    }), { onServerStartError }, {
      createStdioTransport: () => createTransport(),
      createClient: async (config) => {
        throw new Error(`${config.clientName} unavailable`);
      },
    });

    await expect(provider.start()).rejects.toThrow(
      'Failed to initialize every configured MCP server: "first": desk-pet:first unavailable; '
      + '"second": desk-pet:second unavailable.',
    );
    expect(onServerStartError).toHaveBeenCalledTimes(2);
    expect(provider.getDescriptors()).toEqual([]);
  });

  it("bounds best-effort client close when a remote DELETE never settles", async () => {
    const client = createMockClient([{ tools: [] }], {});
    vi.mocked(client.close).mockImplementation(() => new Promise<void>(() => undefined));
    const provider = McpToolProvider.fromConfigContents(JSON.stringify({
      mcpServers: { remote: { url: "https://mcp.example.com/mcp" } },
    }), { closeTimeoutMs: 2_000 }, { createClient: async () => client });
    await provider.start();

    vi.useFakeTimers();
    try {
      const closing = provider.close().then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(closing).resolves.toMatchObject({
        errors: [expect.objectContaining({ message: expect.stringContaining("timed out") })],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when an HTTP credential placeholder is missing", async () => {
    const createClient = vi.fn();
    const provider = McpToolProvider.fromConfigContents(JSON.stringify({
      mcpServers: {
        remote: {
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: "Bearer ${MISSING_TOKEN}" },
        },
      },
    }), {}, { createClient, processEnv: {} });

    await expect(provider.start()).rejects.toThrow("missing environment variable");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("rejects a credential placeholder that resolves to a header injection", async () => {
    const createClient = vi.fn();
    const provider = McpToolProvider.fromConfigContents(JSON.stringify({
      mcpServers: {
        remote: {
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: "Bearer ${TOKEN}" },
        },
      },
    }), {}, { createClient, processEnv: { TOKEN: "safe\r\ninjected: true" } });

    await expect(provider.start()).rejects.toThrow("unsafe value");
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe("MCP tool safety helpers", () => {
  it("requires approval for every server while retaining annotation metadata", () => {
    expect(classifyMcpToolApproval({ annotations: { readOnlyHint: true } } as never))
      .toMatchObject({ requiresApproval: true, reason: "read-only", readOnlyHint: true });
    expect(classifyMcpToolApproval({
      annotations: { readOnlyHint: true, destructiveHint: true },
    } as never)).toMatchObject({ requiresApproval: true, reason: "destructive" });
    expect(classifyMcpToolApproval({ annotations: undefined }))
      .toMatchObject({ requiresApproval: true, reason: "unclassified" });
  });

  it("leaves package-manager resolution to the SDK's cross-spawn transport", () => {
    expect(normalizeStdioConfig({
      transport: "stdio",
      command: "npx",
      args: ["-y", "server"],
    })).toMatchObject({
      command: "npx",
      args: ["-y", "server"],
    });
    expect(normalizeStdioConfig({ transport: "stdio", command: "node" }))
      .toMatchObject({ command: "node" });
  });

  it("merges stdio server variables over the inherited process environment", () => {
    expect(normalizeStdioConfig({
      transport: "stdio",
      command: "npx",
      env: { TOKEN: "configured", PATH: "configured-path" },
    }, {
      PATH: "inherited-path",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      SystemRoot: "C:\\Windows",
    })).toMatchObject({
      env: {
        PATH: "configured-path",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        SystemRoot: "C:\\Windows",
        TOKEN: "configured",
      },
    });
  });

  it("generates stable names within the OpenAI-compatible tool name limit", () => {
    expect(createMcpAgentToolName("Context 7", "resolve/library.id"))
      .toBe("mcp__context_7__resolve_library_id");
    const longName = createMcpAgentToolName("server".repeat(20), "tool".repeat(30));
    expect(longName).toHaveLength(64);
    expect(longName).toMatch(/^mcp__[a-z0-9_-]+__[a-f0-9]{10}$/);
    expect(createMcpAgentToolName("server".repeat(20), "tool".repeat(30)))
      .toBe(longName);
  });
});
