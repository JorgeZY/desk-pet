import { describe, expect, it } from "vitest";
import { validateMcpServersConfigContents } from "./mcp-servers-config";

describe("MCP servers config", () => {
  it("accepts a Cursor-compatible stdio server", () => {
    expect(() => validateMcpServersConfigContents(JSON.stringify({
      mcpServers: { local: { command: "node", args: ["server.js"] } },
    }))).not.toThrow();
  });

  it("rejects malformed or non-stdio configurations", () => {
    expect(() => validateMcpServersConfigContents("{"))
      .toThrow("不是有效的 JSON");
    expect(() => validateMcpServersConfigContents('{"mcpServers":{"remote":{"url":"https://example.com"}}}'))
      .toThrow("缺少 stdio command");
  });
});
