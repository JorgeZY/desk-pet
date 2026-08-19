interface McpServerConfig {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  url?: unknown;
  headers?: unknown;
}

interface McpServersDocument {
  mcpServers: Record<string, McpServerConfig>;
}

function parseMcpServersConfig(contents: string): McpServersDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error("MCP Servers 配置不是有效的 JSON。");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MCP Servers 配置必须是 JSON 对象。");
  }
  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error("MCP Servers 配置缺少 mcpServers 对象。");
  }
  const entries = Object.entries(servers as Record<string, unknown>);
  if (!entries.length) throw new Error("MCP Servers 配置中没有可加载的 server。");
  for (const [name, value] of entries) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`MCP server「${name}」配置无效。`);
    }
    const config = value as McpServerConfig;
    const command = typeof config.command === "string" ? config.command.trim() : "";
    const url = typeof config.url === "string" ? config.url.trim() : "";
    if (!command && !url) {
      throw new Error(`MCP server「${name}」缺少 stdio command 或 remote url。`);
    }
    if (command && url) {
      throw new Error(`MCP server「${name}」不能同时配置 command 与 url。`);
    }
    if (url) {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        throw new Error(`MCP server「${name}」的 remote url 无效。`);
      }
      if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
        throw new Error(`MCP server「${name}」的 remote url 必须使用 http 或 https。`);
      }
      if (config.headers !== undefined && (
        !config.headers || typeof config.headers !== "object" || Array.isArray(config.headers)
      )) {
        throw new Error(`MCP server「${name}」的 headers 必须是 JSON 对象。`);
      }
      for (const [header, headerValue] of Object.entries(
        (config.headers ?? {}) as Record<string, unknown>,
      )) {
        if (!header.trim() || typeof headerValue !== "string") {
          throw new Error(`MCP server「${name}」包含无效的 remote header。`);
        }
      }
    }
  }
  return { mcpServers: servers as Record<string, McpServerConfig> };
}

export function validateMcpServersConfigContents(contents: string): void {
  parseMcpServersConfig(contents);
}

export function prepareMcpServersConfigContents(
  contents: string,
  platform = process.platform,
): string {
  const parsed = parseMcpServersConfig(contents);
  let changed = false;
  const mcpServers = Object.fromEntries(Object.entries(parsed.mcpServers).map(([name, source]) => {
    const config = { ...source } as Record<string, unknown>;
    const command = typeof source.command === "string" ? source.command.trim() : "";
    const url = typeof source.url === "string" ? source.url.trim() : "";

    if (url) {
      const bridgeArgs = ["-y", "mcp-remote@latest", url, "--silent"];
      for (const [header, value] of Object.entries(
        (source.headers ?? {}) as Record<string, string>,
      )) {
        bridgeArgs.push("--header", `${header}: ${value}`);
      }
      if (url.startsWith("http://")) bridgeArgs.push("--allow-http");
      config.command = platform === "win32" ? "cmd.exe" : "npx";
      config.args = platform === "win32"
        ? ["/d", "/s", "/c", "npx", ...bridgeArgs]
        : bridgeArgs;
      delete config.url;
      delete config.headers;
      changed = true;
    } else if (
      platform === "win32" &&
      ["npm", "npx", "pnpm", "pnpx", "yarn", "yarnpkg"].includes(command.toLowerCase())
    ) {
      const args = Array.isArray(source.args) ? source.args : [];
      config.command = "cmd.exe";
      config.args = ["/d", "/s", "/c", command, ...args];
      changed = true;
    }
    return [name, config];
  }));

  return changed ? `${JSON.stringify({ mcpServers }, null, 2)}\n` : contents;
}
