import { describe, expect, it } from "vitest";
import {
  parseMcpServersConfigContents,
  validateMcpServersConfigContents,
} from "./mcp-servers-config";

describe("MCP servers config", () => {
  it("accepts a Cursor-compatible stdio server", () => {
    expect(() => validateMcpServersConfigContents(JSON.stringify({
      mcpServers: { local: { command: "node", args: ["server.js"] } },
    }))).not.toThrow();
  });

  it("returns a normalized provider-facing config", () => {
    expect(parseMcpServersConfigContents(JSON.stringify({
      mcpServers: {
        local: {
          command: " node ",
          args: ["server.js"],
          env: { TOKEN: "secret" },
          cwd: " D:\\tools ",
        },
        remote: {
          url: " https://mcp.example.com/mcp ",
          headers: { Authorization: "Bearer ${TOKEN}" },
          env: { TOKEN: "secret" },
        },
      },
    }))).toEqual({
      mcpServers: {
        local: {
          transport: "stdio",
          command: "node",
          args: ["server.js"],
          env: { TOKEN: "secret" },
          cwd: "D:\\tools",
        },
        remote: {
          transport: "auto",
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: "Bearer ${TOKEN}" },
          env: { TOKEN: "secret" },
        },
      },
    });
  });

  it("rejects malformed stdio arguments and environment values", () => {
    expect(() => validateMcpServersConfigContents(JSON.stringify({
      mcpServers: { local: { command: "node", args: [1] } },
    }))).toThrow("args 必须是");
    expect(() => validateMcpServersConfigContents(JSON.stringify({
      mcpServers: { local: { command: "node", env: { TOKEN: 123 } } },
    }))).toThrow("无效的环境变量");
    expect(() => validateMcpServersConfigContents(JSON.stringify({
      mcpServers: { local: { command: "node", cwd: "bad\npath" } },
    }))).toThrow("cwd 必须是");
    expect(() => validateMcpServersConfigContents(JSON.stringify({
      mcpServers: { remote: { url: "https://mcp.example.com", cwd: "D:\\tools" } },
    }))).toThrow("remote url 不能配置 cwd");
  });

  it("rejects unsafe server and HTTP header text", () => {
    expect(() => validateMcpServersConfigContents(JSON.stringify({
      mcpServers: { "\n": { command: "node" } },
    }))).toThrow("名称不能为空或包含换行");
    expect(() => validateMcpServersConfigContents(JSON.stringify({
      mcpServers: {
        remote: {
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: "Bearer value\r\ninjected: true" },
        },
      },
    }))).toThrow("无效的 remote header");
  });

  it("accepts remote HTTP servers and rejects malformed transports", () => {
    expect(() => validateMcpServersConfigContents(JSON.stringify({
      mcpServers: { remote: { url: "https://mcp.example.com/mcp" } },
    }))).not.toThrow();
    expect(() => validateMcpServersConfigContents("{"))
      .toThrow("不是有效的 JSON");
    expect(() => validateMcpServersConfigContents('{"mcpServers":{"remote":{"url":"file:///tmp/mcp"}}}'))
      .toThrow("必须使用 http 或 https");
    expect(() => validateMcpServersConfigContents(JSON.stringify({
      mcpServers: { remote: { url: "https://user:secret@mcp.example.com/mcp" } },
    }))).toThrow("不能包含凭据");
    expect(() => validateMcpServersConfigContents(JSON.stringify({
      mcpServers: { local: { url: "http://127.0.0.1:3333/mcp" } },
    }))).not.toThrow();
    expect(() => validateMcpServersConfigContents(JSON.stringify({
      mcpServers: {
        remote: {
          url: "http://mcp.example.com/mcp",
          headers: { Authorization: "Bearer ${TOKEN}" },
        },
      },
    }))).toThrow("远程地址必须使用 HTTPS");
  });

  it("normalizes explicit Streamable HTTP and legacy SSE transports", () => {
    expect(parseMcpServersConfigContents(JSON.stringify({
      mcpServers: {
        streamable: {
          url: "https://mcp.example.com/mcp",
          transport: "streamable-http",
        },
        legacy: {
          url: "https://mcp.example.com/sse",
          type: "sse",
        },
      },
    }))).toEqual({
      mcpServers: {
        streamable: {
          transport: "http",
          url: "https://mcp.example.com/mcp",
        },
        legacy: {
          transport: "sse",
          url: "https://mcp.example.com/sse",
        },
      },
    });
  });

  it("rejects conflicting or incompatible transport declarations", () => {
    expect(() => validateMcpServersConfigContents(JSON.stringify({
      mcpServers: {
        remote: {
          url: "https://mcp.example.com/mcp",
          transport: "http",
          type: "sse",
        },
      },
    }))).toThrow("相互冲突");
    expect(() => validateMcpServersConfigContents(JSON.stringify({
      mcpServers: { remote: { url: "https://mcp.example.com/mcp", type: "stdio" } },
    }))).toThrow("remote url 不能使用 stdio");
    expect(() => validateMcpServersConfigContents(JSON.stringify({
      mcpServers: { local: { command: "node", transport: "sse" } },
    }))).toThrow("command 只能使用 stdio");
  });
});
