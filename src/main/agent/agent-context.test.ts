import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config-store";
import { prepareAgentStepMessages } from "./agent-context";
import {
  toolResultPromptByteBudget,
  utf8ByteLength,
} from "./tool-result-budget";

function toolRound(id: string, value: string): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: [{
        type: "tool-call",
        toolCallId: id,
        toolName: "read_file",
        input: { path: `${id}.txt` },
      }],
    },
    {
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: id,
        toolName: "read_file",
        output: { type: "text", value },
      }],
    },
  ];
}

describe("prepareAgentStepMessages", () => {
  it("keeps two recent tool rounds inside one 8K-context budget", () => {
    const prepared = prepareAgentStepMessages([
      { role: "user", content: "inspect files" },
      ...toolRound("call-old", "old".repeat(4_000)),
      ...toolRound("call-middle", "中".repeat(4_000)),
      ...toolRound("call-new", "new".repeat(4_000)),
    ], DEFAULT_CONFIG);
    const serialized = JSON.stringify(prepared);
    const resultValues = prepared.flatMap((message) => message.role === "tool"
      ? message.content.flatMap((part) => part.type === "tool-result"
        && part.output.type === "text" ? [part.output.value] : [])
      : []);

    expect(serialized).not.toContain("call-old");
    expect(serialized).toContain("call-middle");
    expect(serialized).toContain("call-new");
    expect(resultValues.reduce((total, value) => total + utf8ByteLength(value), 0))
      .toBeLessThanOrEqual(toolResultPromptByteBudget(DEFAULT_CONFIG));
  });
});
