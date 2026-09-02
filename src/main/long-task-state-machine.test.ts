import { describe, expect, it } from "vitest";
import {
  assertLongTaskStepTransition,
  assertLongTaskTransition,
  canTransitionLongTask,
  canTransitionLongTaskStep,
  isLongTaskStepTerminal,
  isLongTaskTerminal,
} from "./long-task-state-machine";

describe("long task state machine", () => {
  it("allows the explicit execution, approval, pause, and resume path", () => {
    expect(canTransitionLongTask("draft", "queued")).toBe(true);
    expect(canTransitionLongTask("queued", "running")).toBe(true);
    expect(canTransitionLongTask("running", "waiting-approval")).toBe(true);
    expect(canTransitionLongTask("waiting-approval", "running")).toBe(true);
    expect(canTransitionLongTask("running", "paused")).toBe(true);
    expect(canTransitionLongTask("paused", "queued")).toBe(true);
    expect(canTransitionLongTask("interrupted", "queued")).toBe(true);
  });

  it("rejects skipping required task states and keeps terminal states immutable", () => {
    expect(() => assertLongTaskTransition("draft", "running")).toThrow(/不能从 draft/);
    expect(() => assertLongTaskTransition("paused", "completed")).toThrow(/不能从 paused/);
    expect(() => assertLongTaskTransition("completed", "queued")).toThrow(/不能从 completed/);
    expect(() => assertLongTaskTransition("failed", "queued")).toThrow(/不能从 failed/);
    expect(() => assertLongTaskTransition("cancelled", "running")).toThrow(/不能从 cancelled/);
    expect(isLongTaskTerminal("completed")).toBe(true);
    expect(isLongTaskTerminal("paused")).toBe(false);
  });

  it("allows interrupted steps to retry but not completed or cancelled steps", () => {
    expect(canTransitionLongTaskStep("pending", "running")).toBe(true);
    expect(canTransitionLongTaskStep("running", "interrupted")).toBe(true);
    expect(canTransitionLongTaskStep("interrupted", "running")).toBe(true);
    expect(canTransitionLongTaskStep("interrupted", "failed")).toBe(true);
    expect(() => assertLongTaskStepTransition("pending", "completed")).toThrow(/步骤不能从 pending/);
    expect(() => assertLongTaskStepTransition("completed", "running")).toThrow(/步骤不能从 completed/);
    expect(isLongTaskStepTerminal("failed")).toBe(true);
    expect(isLongTaskStepTerminal("interrupted")).toBe(false);
  });
});
