import type { LongTaskStatus, LongTaskStepStatus } from "../shared/types";

const TASK_TRANSITIONS: Readonly<Record<LongTaskStatus, ReadonlySet<LongTaskStatus>>> = {
  draft: new Set(["queued", "cancelled"]),
  queued: new Set(["running", "paused", "interrupted", "failed", "cancelled"]),
  running: new Set([
    "queued",
    "waiting-approval",
    "paused",
    "interrupted",
    "completed",
    "failed",
    "cancelled",
  ]),
  "waiting-approval": new Set(["running", "paused", "interrupted", "failed", "cancelled"]),
  paused: new Set(["queued", "failed", "cancelled"]),
  interrupted: new Set(["queued", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

const STEP_TRANSITIONS: Readonly<Record<LongTaskStepStatus, ReadonlySet<LongTaskStepStatus>>> = {
  pending: new Set(["running", "cancelled"]),
  running: new Set(["interrupted", "completed", "failed", "cancelled"]),
  interrupted: new Set(["running", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export const LONG_TASK_TERMINAL_STATUSES: ReadonlySet<LongTaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export const LONG_TASK_STEP_TERMINAL_STATUSES: ReadonlySet<LongTaskStepStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export function isLongTaskTerminal(status: LongTaskStatus): boolean {
  return LONG_TASK_TERMINAL_STATUSES.has(status);
}

export function isLongTaskStepTerminal(status: LongTaskStepStatus): boolean {
  return LONG_TASK_STEP_TERMINAL_STATUSES.has(status);
}

export function canTransitionLongTask(
  current: LongTaskStatus,
  next: LongTaskStatus,
): boolean {
  return current === next || TASK_TRANSITIONS[current].has(next);
}

export function canTransitionLongTaskStep(
  current: LongTaskStepStatus,
  next: LongTaskStepStatus,
): boolean {
  return current === next || STEP_TRANSITIONS[current].has(next);
}

export function assertLongTaskTransition(
  current: LongTaskStatus,
  next: LongTaskStatus,
): void {
  if (!canTransitionLongTask(current, next)) {
    throw new Error(`长期任务不能从 ${current} 转换为 ${next}。`);
  }
}

export function assertLongTaskStepTransition(
  current: LongTaskStepStatus,
  next: LongTaskStepStatus,
): void {
  if (!canTransitionLongTaskStep(current, next)) {
    throw new Error(`长期任务步骤不能从 ${current} 转换为 ${next}。`);
  }
}
