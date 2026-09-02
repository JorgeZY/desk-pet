import type { AgentToolDescriptor } from "./tool-provider";

const MAX_AGENT_TOOLS_PER_RUN = 32;
const MAX_TOOL_SCHEMA_TOKEN_BUDGET = 16_384;
const MIN_TOOL_SCHEMA_BYTES = 128;
// Tool definitions are predominantly ASCII JSON. Three serialized bytes per
// token is deliberately more conservative than the usual ~4 chars/token,
// without treating every two bytes as a token and dropping ordinary toolsets.
const ESTIMATED_SCHEMA_BYTES_PER_TOKEN = 3;

export interface AgentToolSelection {
  tools: AgentToolDescriptor[];
  omitted: AgentToolDescriptor[];
  /** Conservative estimate reserved from the model context. */
  schemaTokens: number;
  schemaTokenBudget: number;
}

/**
 * Bounds model-visible tool schemas before the first request. Tools retain
 * provider order (local knowledge, builtin, then configured MCP servers); skipped tools
 * are always surfaced to the user by the caller.
 */
export function selectAgentToolsForContext(
  descriptors: readonly AgentToolDescriptor[],
  contextSize: number,
): AgentToolSelection {
  const schemaTokenBudget = Math.min(
    MAX_TOOL_SCHEMA_TOKEN_BUDGET,
    Math.max(1_024, Math.floor(contextSize * 0.5)),
  );
  const tools: AgentToolDescriptor[] = [];
  const omitted: AgentToolDescriptor[] = [];
  let schemaTokens = 0;

  for (const descriptor of descriptors) {
    const descriptorTokens = Math.ceil(
      serializedToolSchemaBytes(descriptor) / ESTIMATED_SCHEMA_BYTES_PER_TOKEN,
    );
    if (
      tools.length >= MAX_AGENT_TOOLS_PER_RUN
      || schemaTokens + descriptorTokens > schemaTokenBudget
    ) {
      omitted.push(descriptor);
      continue;
    }
    tools.push(descriptor);
    schemaTokens += descriptorTokens;
  }

  return { tools, omitted, schemaTokens, schemaTokenBudget };
}

export function serializedToolSchemaBytes(descriptor: AgentToolDescriptor): number {
  const inputSchema = descriptor.tool.inputSchema as unknown;
  const schema = inputSchema && typeof inputSchema === "object" && "jsonSchema" in inputSchema
    ? (inputSchema as { jsonSchema: unknown }).jsonSchema
    : inputSchema;
  try {
    const serialized = JSON.stringify({
      type: "function",
      function: {
        name: descriptor.name,
        description: descriptor.tool.description ?? descriptor.displayName,
        parameters: schema,
      },
    });
    return Math.max(MIN_TOOL_SCHEMA_BYTES, Buffer.byteLength(serialized, "utf8"));
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}
