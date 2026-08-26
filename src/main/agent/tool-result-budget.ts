import type { RuntimeConfig } from "../../shared/types";

const TOOL_RESULT_TRUNCATION_SUFFIX = "\n\n[工具结果过长，已截断]";
const TOOL_RESULT_SHORT_MARKER = "[已截断]";
const MAX_TOOL_RESULT_PROMPT_BYTES = 16_000;
const PROMPT_SAFETY_TOKENS = 256;
export const DIAGNOSTIC_TEXT_BYTE_LIMIT = 16_000;

export interface FittedToolResults {
  values: string[];
  truncated: boolean;
}

/**
 * Reserves most of the input window for instructions, conversation history,
 * tool schemas, and tool-call arguments. UTF-8 bytes are used as a deliberately
 * conservative upper bound for local tokenizer input.
 */
export function toolResultPromptByteBudget(
  config: Pick<RuntimeConfig, "contextSize" | "maxTokens">,
): number {
  const contextSize = Math.max(0, Math.floor(config.contextSize));
  const outputReserve = Math.min(
    contextSize,
    Math.max(0, Math.floor(config.maxTokens)),
  );
  const available = Math.max(0, contextSize - outputReserve - PROMPT_SAFETY_TOKENS);
  if (available === 0) return 0;
  return Math.min(
    MAX_TOOL_RESULT_PROMPT_BYTES,
    available,
    Math.max(128, Math.floor(available / 3)),
  );
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function truncateToolResultToBytes(value: string, byteLimit: number): string {
  const limit = Math.max(0, Math.floor(byteLimit));
  if (utf8ByteLength(value) <= limit) return value;
  if (limit === 0) return "";

  const suffixBytes = utf8ByteLength(TOOL_RESULT_TRUNCATION_SUFFIX);
  if (limit <= suffixBytes) {
    return sliceToUtf8Bytes(TOOL_RESULT_SHORT_MARKER, limit);
  }
  return `${sliceToUtf8Bytes(value, limit - suffixBytes)}${TOOL_RESULT_TRUNCATION_SUFFIX}`;
}

export function truncateDiagnosticText(
  value: string,
  byteLimit = DIAGNOSTIC_TEXT_BYTE_LIMIT,
): string {
  const limit = Math.max(0, Math.floor(byteLimit));
  if (utf8ByteLength(value) <= limit) return value;
  if (limit === 0) return "";

  const suffix = "\n\n[诊断信息过长，已截断]";
  const suffixBytes = utf8ByteLength(suffix);
  if (limit <= suffixBytes) return sliceToUtf8Bytes("[已截断]", limit);
  return `${sliceToUtf8Bytes(value, limit - suffixBytes)}${suffix}`;
}

/**
 * Fits all results into one shared prompt budget. Small results retain their
 * full value and the remaining budget is divided fairly between long results.
 */
export function fitToolResultTexts(
  values: readonly string[],
  totalByteBudget: number,
): FittedToolResults {
  if (values.length === 0) return { values: [], truncated: false };

  const totalBudget = Math.max(0, Math.floor(totalByteBudget));
  const lengths = values.map(utf8ByteLength);
  if (lengths.reduce((total, length) => total + length, 0) <= totalBudget) {
    return { values: [...values], truncated: false };
  }

  const allocations = new Array<number>(values.length).fill(0);
  const pending = lengths
    .map((length, index) => ({ index, length }))
    .sort((left, right) => left.length - right.length);
  let remainingBudget = totalBudget;

  for (let offset = 0; offset < pending.length; offset += 1) {
    const remainingCount = pending.length - offset;
    const share = Math.floor(remainingBudget / remainingCount);
    const current = pending[offset];
    if (current.length <= share) {
      allocations[current.index] = current.length;
      remainingBudget -= current.length;
      continue;
    }

    const remainder = remainingBudget % remainingCount;
    for (let index = offset; index < pending.length; index += 1) {
      allocations[pending[index].index] = share + (index - offset < remainder ? 1 : 0);
    }
    remainingBudget = 0;
    break;
  }

  return {
    values: values.map((value, index) => truncateToolResultToBytes(value, allocations[index])),
    truncated: true,
  };
}

function sliceToUtf8Bytes(value: string, byteLimit: number): string {
  let used = 0;
  let result = "";
  for (const character of value) {
    const size = utf8ByteLength(character);
    if (used + size > byteLimit) break;
    result += character;
    used += size;
  }
  return result;
}
