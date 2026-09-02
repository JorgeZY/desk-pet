import type { ToolSet } from "ai";

export type AgentToolSource = "builtin" | "mcp" | "knowledge" | "task";

export interface AgentToolDescriptor {
  /** Stable, model-visible name. */
  name: string;
  /** Human-readable name for approval and progress UI. */
  displayName: string;
  source: AgentToolSource;
  /** The runner owns the approval interaction; providers only classify tools. */
  requiresApproval: boolean;
  /** Original executable AI SDK tool. */
  tool: ToolSet[string];
  metadata?: Readonly<Record<string, unknown>>;
}

export interface ToolProvider {
  start(signal?: AbortSignal): Promise<void>;
  getDescriptors(): readonly AgentToolDescriptor[];
  close(): Promise<void>;
}

/**
 * Merge provider output without silently replacing a tool. Tool names are part
 * of the model contract, so collisions are configuration errors.
 */
export function mergeToolDescriptors(
  descriptorGroups: ReadonlyArray<readonly AgentToolDescriptor[]>,
): AgentToolDescriptor[] {
  const merged: AgentToolDescriptor[] = [];
  const owners = new Map<string, AgentToolDescriptor>();

  for (const group of descriptorGroups) {
    for (const descriptor of group) {
      const existing = owners.get(descriptor.name);
      if (existing) {
        throw new Error(
          `Agent tool name collision: "${descriptor.name}" (${describeTool(existing)} / ${describeTool(descriptor)}).`,
        );
      }
      owners.set(descriptor.name, descriptor);
      merged.push(descriptor);
    }
  }

  return merged;
}

export function descriptorsToToolSet(
  descriptors: readonly AgentToolDescriptor[],
): ToolSet {
  const tools: ToolSet = {};
  for (const descriptor of mergeToolDescriptors([descriptors])) {
    tools[descriptor.name] = descriptor.tool;
  }
  return tools;
}

function describeTool(descriptor: AgentToolDescriptor): string {
  if (descriptor.source !== "mcp") return descriptor.source;
  const serverName = descriptor.metadata?.serverName;
  const originalName = descriptor.metadata?.originalName;
  return ["mcp", serverName, originalName]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(":");
}
