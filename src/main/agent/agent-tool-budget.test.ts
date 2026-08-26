import { dynamicTool, jsonSchema } from "ai";
import { describe, expect, it } from "vitest";
import {
  selectAgentToolsForContext,
  serializedToolSchemaBytes,
} from "./agent-tool-budget";
import type { AgentToolDescriptor } from "./tool-provider";

function descriptor(name: string, description = "read a local value"): AgentToolDescriptor {
  return {
    name,
    displayName: name,
    source: "builtin",
    requiresApproval: false,
    tool: dynamicTool({
      description,
      inputSchema: jsonSchema({
        type: "object",
        properties: { path: { type: "string", description } },
      }),
      execute: async () => "ok",
    }),
  };
}

describe("selectAgentToolsForContext", () => {
  it("keeps tool schemas inside a bounded share of an 8K context", () => {
    const selection = selectAgentToolsForContext(
      Array.from({ length: 50 }, (_, index) => descriptor(`tool_${index}`)),
      8_192,
    );

    expect(selection.tools.length).toBeGreaterThan(0);
    expect(selection.tools.length).toBeLessThanOrEqual(32);
    expect(selection.omitted.length).toBeGreaterThan(0);
    expect(selection.schemaTokens).toBeLessThanOrEqual(selection.schemaTokenBudget);
    expect(selection.schemaTokenBudget).toBe(Math.floor(8_192 * 0.5));
  });

  it("keeps a normal nine-tool desktop and web-search set in an 8K context", () => {
    const ordinary = Array.from({ length: 6 }, (_, index) =>
      descriptor(`desktop_tool_${index}`, "read or update a small desktop value"));
    const dateTime = descriptor("get_date_time", "return the current local date and time");
    const webSearch = descriptor("web_search_exa", "search the web".repeat(40));
    const webFetch = descriptor("web_fetch_exa", "fetch one selected web result".repeat(24));

    const selection = selectAgentToolsForContext(
      [...ordinary, dateTime, webSearch, webFetch],
      8_192,
    );

    expect(selection.tools).toHaveLength(9);
    expect(selection.omitted).toEqual([]);
    expect(selection.schemaTokens).toBeLessThanOrEqual(selection.schemaTokenBudget);
  });

  it("skips one oversized schema while retaining later small tools", () => {
    const oversized = descriptor("oversized", "x".repeat(20_000));
    const small = descriptor("small");
    const selection = selectAgentToolsForContext([oversized, small], 8_192);

    expect(selection.tools.map(({ name }) => name)).toEqual(["small"]);
    expect(selection.omitted.map(({ name }) => name)).toEqual(["oversized"]);
    expect(serializedToolSchemaBytes(oversized)).toBeGreaterThan(
      serializedToolSchemaBytes(small),
    );
  });
});
