export function validateMcpServersConfigContents(contents: string): void {
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
    const command = (value as { command?: unknown }).command;
    if (typeof command !== "string" || !command.trim()) {
      throw new Error(`MCP server「${name}」缺少 stdio command。`);
    }
  }
}
