import { pruneMessages, type ModelMessage } from "ai";
import type { RuntimeConfig } from "../../shared/types";
import {
  fitToolResultTexts,
  toolResultPromptByteBudget,
} from "./tool-result-budget";

/**
 * Keeps the two most recent tool rounds as a bounded, ephemeral scratchpad.
 * This prevents an unconstrained tool loop from growing the next local-model
 * request without introducing summaries, long-term memory, or RAG.
 */
export function prepareAgentStepMessages(
  messages: ModelMessage[],
  config: Pick<RuntimeConfig, "contextSize" | "maxTokens">,
): ModelMessage[] {
  const pruned = pruneMessages({
    messages,
    reasoning: "before-last-message",
    toolCalls: "before-last-4-messages",
  });
  const resultValues: string[] = [];

  for (const message of pruned) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (isTextToolResult(part)) resultValues.push(part.output.value);
    }
  }

  const fitted = fitToolResultTexts(
    resultValues,
    toolResultPromptByteBudget(config),
  ).values;
  let resultIndex = 0;

  return pruned.map((message) => {
    if (message.role !== "tool") return message;
    return {
      ...message,
      content: message.content.map((part) => {
        if (!isTextToolResult(part)) return part;
        const value = fitted[resultIndex] ?? "";
        resultIndex += 1;
        return { ...part, output: { ...part.output, value } };
      }),
    } as ModelMessage;
  });
}

function isTextToolResult(part: unknown): part is {
  type: "tool-result";
  output: { type: "text"; value: string };
} {
  if (!part || typeof part !== "object") return false;
  const candidate = part as {
    type?: unknown;
    output?: { type?: unknown; value?: unknown };
  };
  return candidate.type === "tool-result"
    && candidate.output?.type === "text"
    && typeof candidate.output.value === "string";
}
