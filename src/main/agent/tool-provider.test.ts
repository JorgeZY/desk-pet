import type { ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import type { AgentToolDescriptor } from "./tool-provider";
import { descriptorsToToolSet, mergeToolDescriptors } from "./tool-provider";

function descriptor(name: string, source: "builtin" | "mcp"): AgentToolDescriptor {
  return {
    name,
    displayName: name,
    source,
    requiresApproval: false,
    tool: { inputSchema: {} } as ToolSet[string],
  };
}

describe("tool provider composition", () => {
  it("merges descriptors and converts them to an AI SDK tool set", () => {
    const builtin = descriptor("read_file", "builtin");
    const mcp = descriptor("mcp__docs__search", "mcp");

    expect(mergeToolDescriptors([[builtin], [mcp]])).toEqual([builtin, mcp]);
    expect(descriptorsToToolSet([builtin, mcp])).toEqual({
      read_file: builtin.tool,
      mcp__docs__search: mcp.tool,
    });
  });

  it("rejects duplicate names instead of silently replacing tools", () => {
    expect(() => mergeToolDescriptors([
      [descriptor("duplicate", "builtin")],
      [descriptor("duplicate", "mcp")],
    ])).toThrow("Agent tool name collision");
  });
});
