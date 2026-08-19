import { describe, expect, it } from "vitest";
import {
  prepareMcpServersConfigContents,
  validateMcpServersConfigContents,
} from "./mcp-servers-config";

describe("MCP servers config", () => {
  it("accepts a Cursor-compatible stdio server", () => {
    expect(() => validateMcpServersConfigContents(JSON.stringify({
      mcpServers: { local: { command: "node", args: ["server.js"] } },
    }))).not.toThrow();
  });

  it("accepts remote HTTP servers and rejects malformed transports", () => {
    expect(() => validateMcpServersConfigContents(JSON.stringify({
      mcpServers: { remote: { url: "https://mcp.example.com/mcp" } },
    }))).not.toThrow();
    expect(() => validateMcpServersConfigContents("{"))
      .toThrow("不是有效的 JSON");
    expect(() => validateMcpServersConfigContents('{"mcpServers":{"remote":{"url":"file:///tmp/mcp"}}}'))
      .toThrow("必须使用 http 或 https");
  });

  it("bridges remote HTTP servers and Windows command shims to stdio", () => {
    const prepared = JSON.parse(prepareMcpServersConfigContents(JSON.stringify({
      mcpServers: {
        remote: {
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: "Bearer ${REMOTE_TOKEN}" },
          env: { REMOTE_TOKEN: "secret" },
        },
        local: { command: "npx", args: ["-y", "local-mcp"] },
      },
    }), "win32"));

    expect(prepared.mcpServers.remote).toMatchObject({
      command: "cmd.exe",
      args: [
        "/d", "/s", "/c", "npx", "-y", "mcp-remote@latest",
        "https://mcp.example.com/mcp", "--silent", "--header",
        "Authorization: Bearer ${REMOTE_TOKEN}",
      ],
      env: { REMOTE_TOKEN: "secret" },
    });
    expect(prepared.mcpServers.remote.url).toBeUndefined();
    expect(prepared.mcpServers.local).toMatchObject({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "npx", "-y", "local-mcp"],
    });
  });
});
