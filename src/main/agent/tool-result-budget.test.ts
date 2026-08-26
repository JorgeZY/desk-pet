import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config-store";
import {
  fitToolResultTexts,
  toolResultPromptByteBudget,
  truncateToolResultToBytes,
  utf8ByteLength,
} from "./tool-result-budget";

describe("tool result budgets", () => {
  it("uses a conservative share of the default 8K context", () => {
    expect(toolResultPromptByteBudget(DEFAULT_CONFIG)).toBe(2_474);
  });

  it("shares the byte budget while preserving small results", () => {
    const fitted = fitToolResultTexts(
      ["ok", "你".repeat(4_000), "x".repeat(8_000)],
      toolResultPromptByteBudget(DEFAULT_CONFIG),
    );

    expect(fitted.truncated).toBe(true);
    expect(fitted.values[0]).toBe("ok");
    expect(fitted.values.reduce((total, value) => total + utf8ByteLength(value), 0))
      .toBeLessThanOrEqual(toolResultPromptByteBudget(DEFAULT_CONFIG));
    expect(fitted.values[1]).toContain("[工具结果过长，已截断]");
    expect(fitted.values[2]).toContain("[工具结果过长，已截断]");
  });

  it("never splits a multibyte character at a small boundary", () => {
    const value = truncateToolResultToBytes("😀😀😀", 5);
    expect(Buffer.from(value, "utf8").toString("utf8")).toBe(value);
    expect(utf8ByteLength(value)).toBeLessThanOrEqual(5);
  });
});
