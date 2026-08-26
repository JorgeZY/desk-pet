interface RawMcpServerConfig {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  cwd?: unknown;
  url?: unknown;
  headers?: unknown;
  /** Common clients use either `transport` or `type`. */
  transport?: unknown;
  type?: unknown;
}

interface RawMcpServersDocument {
  mcpServers: Record<string, RawMcpServerConfig>;
}

export interface McpStdioServerConfig {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpHttpServerConfig {
  /**
   * `auto` tries Streamable HTTP first and may fall back to legacy SSE.
   * Explicit transports never fall back to another protocol.
   */
  transport: "auto" | "http" | "sse";
  url: string;
  headers?: Record<string, string>;
  /**
   * Optional values used to resolve `${NAME}` placeholders in HTTP headers.
   * This keeps credentials out of the committed header value.
   */
  env?: Record<string, string>;
}

export type ParsedMcpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export interface ParsedMcpServersDocument {
  mcpServers: Record<string, ParsedMcpServerConfig>;
}

type DeclaredMcpTransport = "stdio" | McpHttpServerConfig["transport"];

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "[::1]"
    || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function normalizeTransportValue(
  serverName: string,
  field: "transport" | "type",
  value: unknown,
): DeclaredMcpTransport | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`MCP server「${serverName}」的 ${field} 必须是字符串。`);
  }

  switch (value.trim().toLowerCase()) {
    case "stdio":
      return "stdio";
    case "auto":
      return "auto";
    case "http":
    case "streamable-http":
    case "streamable_http":
    case "streamablehttp":
      return "http";
    case "sse":
      return "sse";
    default:
      throw new Error(
        `MCP server「${serverName}」的 ${field} 必须是 stdio、auto、streamable-http/http 或 sse。`,
      );
  }
}

function declaredTransport(
  serverName: string,
  config: RawMcpServerConfig,
): DeclaredMcpTransport | undefined {
  const transport = normalizeTransportValue(serverName, "transport", config.transport);
  const type = normalizeTransportValue(serverName, "type", config.type);
  if (transport && type && transport !== type) {
    throw new Error(`MCP server「${serverName}」的 transport 与 type 相互冲突。`);
  }
  return transport ?? type;
}

function parseRawMcpServersConfig(contents: string): RawMcpServersDocument {
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
    if (!name.trim() || /[\r\n]/.test(name)) {
      throw new Error("MCP server 名称不能为空或包含换行。");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`MCP server「${name}」配置无效。`);
    }
    const config = value as RawMcpServerConfig;
    const command = typeof config.command === "string" ? config.command.trim() : "";
    const url = typeof config.url === "string" ? config.url.trim() : "";
    const transport = declaredTransport(name, config);
    if (!command && !url) {
      throw new Error(`MCP server「${name}」缺少 stdio command 或 remote url。`);
    }
    if (command && url) {
      throw new Error(`MCP server「${name}」不能同时配置 command 与 url。`);
    }
    if (command && transport && transport !== "stdio") {
      throw new Error(`MCP server「${name}」的 command 只能使用 stdio transport。`);
    }
    if (url && transport === "stdio") {
      throw new Error(`MCP server「${name}」的 remote url 不能使用 stdio transport。`);
    }
    if (command && /[\r\n]/.test(command)) {
      throw new Error(`MCP server「${name}」的 command 不能包含换行。`);
    }
    if (config.args !== undefined && (
      !Array.isArray(config.args) ||
      config.args.some((argument) => typeof argument !== "string" || /[\r\n]/.test(argument))
    )) {
      throw new Error(`MCP server「${name}」的 args 必须是无换行的字符串数组。`);
    }
    if (config.env !== undefined && (
      !config.env || typeof config.env !== "object" || Array.isArray(config.env)
    )) {
      throw new Error(`MCP server「${name}」的 env 必须是 JSON 对象。`);
    }
    for (const [environmentName, environmentValue] of Object.entries(
      (config.env ?? {}) as Record<string, unknown>,
    )) {
      if (!environmentName.trim() || typeof environmentValue !== "string") {
        throw new Error(`MCP server「${name}」包含无效的环境变量。`);
      }
    }
    if (config.cwd !== undefined && (
      typeof config.cwd !== "string"
      || !config.cwd.trim()
      || /[\0\r\n]/.test(config.cwd)
    )) {
      throw new Error(`MCP server「${name}」的 cwd 必须是无空字符或换行的非空字符串。`);
    }
    if (url && config.cwd !== undefined) {
      throw new Error(`MCP server「${name}」的 remote url 不能配置 cwd。`);
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
      if (parsedUrl.protocol === "http:" && !isLoopbackHostname(parsedUrl.hostname)) {
        throw new Error(
          `MCP server「${name}」的远程地址必须使用 HTTPS；HTTP 仅允许本机 loopback。`,
        );
      }
      if (parsedUrl.username || parsedUrl.password) {
        throw new Error(`MCP server「${name}」的 remote url 不能包含凭据，请改用 headers 与环境变量。`);
      }
      if (config.headers !== undefined && (
        !config.headers || typeof config.headers !== "object" || Array.isArray(config.headers)
      )) {
        throw new Error(`MCP server「${name}」的 headers 必须是 JSON 对象。`);
      }
      for (const [header, headerValue] of Object.entries(
        (config.headers ?? {}) as Record<string, unknown>,
      )) {
        if (
          !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(header) ||
          typeof headerValue !== "string" ||
          /[\r\n]/.test(headerValue)
        ) {
          throw new Error(`MCP server「${name}」包含无效的 remote header。`);
        }
      }
    }
  }
  return { mcpServers: servers as Record<string, RawMcpServerConfig> };
}

/** Parse and normalize the Cursor-compatible MCP server document. */
export function parseMcpServersConfigContents(contents: string): ParsedMcpServersDocument {
  const parsed = parseRawMcpServersConfig(contents);
  return {
    mcpServers: Object.fromEntries(Object.entries(parsed.mcpServers).map(([name, config]) => {
      const env = config.env === undefined
        ? undefined
        : { ...(config.env as Record<string, string>) };
      if (typeof config.command === "string" && config.command.trim()) {
        return [name, {
          transport: "stdio",
          command: config.command.trim(),
          ...(config.args === undefined ? {} : { args: [...config.args as string[]] }),
          ...(env === undefined ? {} : { env }),
          ...(config.cwd === undefined ? {} : { cwd: (config.cwd as string).trim() }),
        } satisfies McpStdioServerConfig];
      }
      return [name, {
        transport: (() => {
          const transport = declaredTransport(name, config);
          return transport === undefined
            ? "auto"
            : transport as McpHttpServerConfig["transport"];
        })(),
        url: (config.url as string).trim(),
        ...(config.headers === undefined
          ? {}
          : { headers: { ...(config.headers as Record<string, string>) } }),
        ...(env === undefined ? {} : { env }),
      } satisfies McpHttpServerConfig];
    })),
  };
}

export function validateMcpServersConfigContents(contents: string): void {
  parseRawMcpServersConfig(contents);
}
