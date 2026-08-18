import type { ThinkingEffort } from "./types";

// llama.cpp accepts a numeric `thinking_budget_tokens` value, but does not define
// a portable token budget for each named effort level. These fractions are the
// app's policy and are surfaced in the UI as an explicit "预算".
const APP_THINKING_BUDGET_FRACTIONS: Record<Exclude<ThinkingEffort, "max">, number> = {
  minimal: 0.1,
  low: 0.25,
  medium: 0.5,
  high: 0.75,
  xhigh: 0.9,
};

export function thinkingBudgetFor(effort: ThinkingEffort, maxTokens: number): number {
  const bounded = Math.max(1, Math.floor(maxTokens));
  return effort === "max"
    ? -1
    : Math.max(1, Math.floor(bounded * APP_THINKING_BUDGET_FRACTIONS[effort]));
}

export function thinkingBudgetLimitForDisplay(
  effort: ThinkingEffort,
  maxTokens: number,
): number {
  const budget = thinkingBudgetFor(effort, maxTokens);
  return budget === -1 ? Math.max(1, Math.floor(maxTokens)) : budget;
}
