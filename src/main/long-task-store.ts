import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  LongTask,
  LongTaskCreateInput,
  LongTaskStatus,
  LongTaskStep,
  LongTaskStepStatus,
} from "../shared/types";
import {
  assertLongTaskStepTransition,
  assertLongTaskTransition,
} from "./long-task-state-machine";

export const MAX_LONG_TASK_TITLE_CHARACTERS = 160;
export const MAX_LONG_TASK_OBJECTIVE_CHARACTERS = 8_000;
export const MAX_LONG_TASK_STEPS = 64;
export const MAX_LONG_TASK_STEP_TITLE_CHARACTERS = 200;
export const MAX_LONG_TASK_STEP_INSTRUCTION_CHARACTERS = 8_000;
export const MAX_LONG_TASK_STEP_OUTPUT_CHARACTERS = 200_000;
export const MAX_LONG_TASK_ERROR_CHARACTERS = 4_000;
export const MAX_LONG_TASK_EVENT_PAYLOAD_CHARACTERS = 16_000;
export const DEFAULT_LONG_TASK_EVENTS_PER_TASK = 200;

const DATABASE_VERSION = 1;
const RECOVERY_ERROR = "应用上次退出时任务尚未安全结束。请手动继续。";
const RECOVERABLE_TASK_STATUSES: readonly LongTaskStatus[] = [
  "queued",
  "running",
  "waiting-approval",
];
const DELETABLE_TASK_STATUSES: ReadonlySet<LongTaskStatus> = new Set([
  "draft",
  "paused",
  "interrupted",
  "completed",
  "failed",
  "cancelled",
]);

interface LongTaskRow {
  id: string;
  title: string;
  objective: string;
  status: LongTaskStatus;
  current_step: number;
  error: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
}

interface LongTaskStepRow {
  id: string;
  task_id: string;
  position: number;
  title: string;
  instruction: string;
  status: LongTaskStepStatus;
  attempt_count: number;
  output: string | null;
  error: string | null;
  started_at: number | null;
  completed_at: number | null;
}

interface LongTaskEventRow {
  sequence: number;
  task_id: string;
  type: string;
  payload_json: string;
  created_at: number;
}

export interface StoredLongTaskEvent {
  sequence: number;
  taskId: string;
  type: string;
  payload: unknown;
  createdAt: number;
}

export interface LongTaskStoreOptions {
  now?: () => number;
  createId?: () => string;
  maxEventsPerTask?: number;
}

function requireBoundedText(
  value: unknown,
  label: string,
  maxCharacters: number,
): string {
  if (typeof value !== "string") throw new Error(`${label}必须是字符串。`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}不能为空。`);
  if (normalized.length > maxCharacters) {
    throw new Error(`${label}不能超过 ${maxCharacters} 个字符。`);
  }
  return normalized;
}

function optionalBoundedText(
  value: string | undefined,
  label: string,
  maxCharacters: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label}必须是字符串。`);
  if (value.length > maxCharacters) {
    throw new Error(`${label}不能超过 ${maxCharacters} 个字符。`);
  }
  return value;
}

function requireIdentifier(value: unknown, label: string): string {
  return requireBoundedText(value, label, 128);
}

function normalizeCreateInput(input: LongTaskCreateInput): LongTaskCreateInput {
  if (!input || typeof input !== "object") throw new Error("长期任务参数无效。");
  if (!Array.isArray(input.steps) || input.steps.length < 1) {
    throw new Error("长期任务至少需要一个步骤。");
  }
  if (input.steps.length > MAX_LONG_TASK_STEPS) {
    throw new Error(`长期任务最多包含 ${MAX_LONG_TASK_STEPS} 个步骤。`);
  }
  return {
    title: requireBoundedText(input.title, "长期任务标题", MAX_LONG_TASK_TITLE_CHARACTERS),
    objective: requireBoundedText(
      input.objective,
      "长期任务目标",
      MAX_LONG_TASK_OBJECTIVE_CHARACTERS,
    ),
    steps: input.steps.map((step, index) => {
      if (!step || typeof step !== "object") throw new Error(`步骤 ${index + 1} 参数无效。`);
      return {
        title: requireBoundedText(
          step.title,
          `步骤 ${index + 1} 标题`,
          MAX_LONG_TASK_STEP_TITLE_CHARACTERS,
        ),
        instruction: requireBoundedText(
          step.instruction,
          `步骤 ${index + 1} 指令`,
          MAX_LONG_TASK_STEP_INSTRUCTION_CHARACTERS,
        ),
      };
    }),
  };
}

function stepFromRow(row: LongTaskStepRow): LongTaskStep {
  return {
    id: row.id,
    position: row.position,
    title: row.title,
    instruction: row.instruction,
    status: row.status,
    attemptCount: row.attempt_count,
    ...(row.output === null ? {} : { output: row.output }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  };
}

function taskFromRow(row: LongTaskRow, steps: LongTaskStep[]): LongTask {
  return {
    id: row.id,
    title: row.title,
    objective: row.objective,
    status: row.status,
    currentStep: row.current_step,
    steps,
    ...(row.error === null ? {} : { error: row.error }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  };
}

export class LongTaskStore {
  private readonly database: DatabaseSync;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly maxEventsPerTask: number;

  constructor(filePath: string, options: LongTaskStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.maxEventsPerTask = Math.min(
      5_000,
      Math.max(1, Math.floor(options.maxEventsPerTask ?? DEFAULT_LONG_TASK_EVENTS_PER_TASK)),
    );
    this.database = new DatabaseSync(filePath);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.initializeSchema();
    this.recoverInterruptedTasks();
  }

  close(): void {
    this.database.close();
  }

  listTasks(): LongTask[] {
    const rows = this.database.prepare(`
      SELECT id, title, objective, status, current_step, error,
        created_at, updated_at, started_at, completed_at
      FROM long_tasks
      ORDER BY updated_at DESC, created_at DESC, id DESC
    `).all() as unknown as LongTaskRow[];
    return rows.map((row) => taskFromRow(row, this.listStepRows(row.id).map(stepFromRow)));
  }

  getTask(taskId: string): LongTask {
    const row = this.requireTaskRow(requireIdentifier(taskId, "长期任务 ID"));
    return taskFromRow(row, this.listStepRows(row.id).map(stepFromRow));
  }

  createTask(input: LongTaskCreateInput): LongTask {
    const normalized = normalizeCreateInput(input);
    const taskId = requireIdentifier(this.createId(), "长期任务 ID");
    const stepIds = normalized.steps.map(() => requireIdentifier(this.createId(), "长期任务步骤 ID"));
    const timestamp = this.now();

    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO long_tasks (
          id, title, objective, status, current_step, error,
          created_at, updated_at, started_at, completed_at
        ) VALUES (?, ?, ?, 'draft', 0, NULL, ?, ?, NULL, NULL)
      `).run(taskId, normalized.title, normalized.objective, timestamp, timestamp);
      const insertStep = this.database.prepare(`
        INSERT INTO long_task_steps (
          id, task_id, position, title, instruction, status, attempt_count,
          output, error, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL)
      `);
      normalized.steps.forEach((step, position) => {
        insertStep.run(stepIds[position], taskId, position, step.title, step.instruction);
      });
      this.appendEventUnchecked(taskId, "task-created", {
        status: "draft",
        stepCount: normalized.steps.length,
      }, timestamp);
    });
    return this.getTask(taskId);
  }

  startTask(taskId: string): LongTask {
    const id = requireIdentifier(taskId, "长期任务 ID");
    this.transaction(() => {
      const row = this.requireTaskRow(id);
      if (row.status === "queued") return;
      if (row.status !== "draft") {
        throw new Error(`只有 draft 的长期任务可以首次启动，当前状态为 ${row.status}。`);
      }
      assertLongTaskTransition(row.status, "queued");
      const timestamp = this.nextTimestamp(row.updated_at);
      this.database.prepare(`
        UPDATE long_tasks
        SET status = 'queued', error = NULL, updated_at = ?, completed_at = NULL
        WHERE id = ?
      `).run(timestamp, id);
      this.appendTransitionEvent(id, row.status, "queued", timestamp);
    });
    return this.getTask(id);
  }

  resumeTask(taskId: string): LongTask {
    const id = requireIdentifier(taskId, "长期任务 ID");
    this.transaction(() => {
      const row = this.requireTaskRow(id);
      if (row.status !== "paused" && row.status !== "interrupted") {
        throw new Error(`只有 paused 或 interrupted 的长期任务可以继续，当前状态为 ${row.status}。`);
      }
      assertLongTaskTransition(row.status, "queued");
      const timestamp = this.nextTimestamp(row.updated_at);
      this.database.prepare(`
        UPDATE long_tasks
        SET status = 'queued', error = NULL, updated_at = ?, completed_at = NULL
        WHERE id = ?
      `).run(timestamp, id);
      this.appendTransitionEvent(id, row.status, "queued", timestamp);
    });
    return this.getTask(id);
  }

  markTaskRunning(taskId: string): LongTask {
    const id = requireIdentifier(taskId, "长期任务 ID");
    this.transaction(() => {
      const row = this.requireTaskRow(id);
      if (row.status === "running") return;
      assertLongTaskTransition(row.status, "running");
      const timestamp = this.nextTimestamp(row.updated_at);
      this.database.prepare(`
        UPDATE long_tasks
        SET status = 'running', error = NULL, updated_at = ?,
          started_at = COALESCE(started_at, ?), completed_at = NULL
        WHERE id = ?
      `).run(timestamp, timestamp, id);
      this.appendTransitionEvent(id, row.status, "running", timestamp);
    });
    return this.getTask(id);
  }

  markTaskWaitingApproval(taskId: string): LongTask {
    const id = requireIdentifier(taskId, "长期任务 ID");
    this.transaction(() => {
      const row = this.requireTaskRow(id);
      if (row.status === "waiting-approval") return;
      assertLongTaskTransition(row.status, "waiting-approval");
      const timestamp = this.nextTimestamp(row.updated_at);
      this.database.prepare(`
        UPDATE long_tasks SET status = 'waiting-approval', updated_at = ? WHERE id = ?
      `).run(timestamp, id);
      this.appendTransitionEvent(id, row.status, "waiting-approval", timestamp);
    });
    return this.getTask(id);
  }

  pauseTask(taskId: string, reason?: string): LongTask {
    return this.stopActiveTask(taskId, "paused", reason);
  }

  interruptTask(taskId: string, reason = RECOVERY_ERROR): LongTask {
    return this.stopActiveTask(taskId, "interrupted", reason);
  }

  completeTask(taskId: string): LongTask {
    const id = requireIdentifier(taskId, "长期任务 ID");
    this.transaction(() => {
      const row = this.requireTaskRow(id);
      if (row.status === "completed") return;
      assertLongTaskTransition(row.status, "completed");
      const unfinished = this.database.prepare(`
        SELECT COUNT(*) AS count FROM long_task_steps
        WHERE task_id = ? AND status <> 'completed'
      `).get(id) as { count: number };
      if (unfinished.count > 0) throw new Error("长期任务仍有未完成步骤，不能标记为完成。");
      const stepCount = this.stepCount(id);
      const timestamp = this.nextTimestamp(row.updated_at);
      this.database.prepare(`
        UPDATE long_tasks
        SET status = 'completed', current_step = ?, error = NULL,
          updated_at = ?, completed_at = ?
        WHERE id = ?
      `).run(stepCount, timestamp, timestamp, id);
      this.appendTransitionEvent(id, row.status, "completed", timestamp);
    });
    return this.getTask(id);
  }

  failTask(taskId: string, error: string): LongTask {
    const id = requireIdentifier(taskId, "长期任务 ID");
    const normalizedError = requireBoundedText(error, "长期任务错误", MAX_LONG_TASK_ERROR_CHARACTERS);
    this.transaction(() => {
      const row = this.requireTaskRow(id);
      if (row.status === "failed") return;
      assertLongTaskTransition(row.status, "failed");
      const timestamp = this.nextTimestamp(row.updated_at);
      this.failActiveStepUnchecked(id, normalizedError, timestamp);
      this.database.prepare(`
        UPDATE long_tasks
        SET status = 'failed', error = ?, updated_at = ?, completed_at = ?
        WHERE id = ?
      `).run(normalizedError, timestamp, timestamp, id);
      this.appendTransitionEvent(id, row.status, "failed", timestamp, {
        error: normalizedError,
      });
    });
    return this.getTask(id);
  }

  cancelTask(taskId: string): LongTask {
    const id = requireIdentifier(taskId, "长期任务 ID");
    this.transaction(() => {
      const row = this.requireTaskRow(id);
      if (row.status === "cancelled") return;
      assertLongTaskTransition(row.status, "cancelled");
      const timestamp = this.nextTimestamp(row.updated_at);
      const activeSteps = this.listStepRows(id).filter((step) =>
        step.status === "pending" || step.status === "running" || step.status === "interrupted");
      const cancelStep = this.database.prepare(`
        UPDATE long_task_steps
        SET status = 'cancelled', completed_at = ?, error = NULL
        WHERE id = ? AND task_id = ?
      `);
      for (const step of activeSteps) {
        assertLongTaskStepTransition(step.status, "cancelled");
        cancelStep.run(timestamp, step.id, id);
      }
      this.database.prepare(`
        UPDATE long_tasks
        SET status = 'cancelled', error = NULL, updated_at = ?, completed_at = ?
        WHERE id = ?
      `).run(timestamp, timestamp, id);
      this.appendTransitionEvent(id, row.status, "cancelled", timestamp);
    });
    return this.getTask(id);
  }

  deleteTask(taskId: string): void {
    const id = requireIdentifier(taskId, "长期任务 ID");
    this.transaction(() => {
      const row = this.requireTaskRow(id);
      if (!DELETABLE_TASK_STATUSES.has(row.status)) {
        throw new Error(`状态为 ${row.status} 的长期任务不能删除，请先暂停或取消。`);
      }
      this.database.prepare("DELETE FROM long_tasks WHERE id = ?").run(id);
    });
  }

  startStep(taskId: string, stepId: string): LongTask {
    const id = requireIdentifier(taskId, "长期任务 ID");
    const safeStepId = requireIdentifier(stepId, "长期任务步骤 ID");
    this.transaction(() => {
      const task = this.requireTaskRow(id);
      if (task.status !== "running") {
        throw new Error(`只有 running 的长期任务可以开始步骤，当前状态为 ${task.status}。`);
      }
      const step = this.requireStepRow(id, safeStepId);
      if (step.status === "running") return;
      if (step.position !== task.current_step) {
        throw new Error(`步骤 ${step.position + 1} 不是长期任务当前待执行步骤。`);
      }
      assertLongTaskStepTransition(step.status, "running");
      const timestamp = this.nextTimestamp(task.updated_at);
      this.database.prepare(`
        UPDATE long_task_steps
        SET status = 'running', attempt_count = attempt_count + 1,
          error = NULL, started_at = COALESCE(started_at, ?), completed_at = NULL
        WHERE id = ? AND task_id = ?
      `).run(timestamp, safeStepId, id);
      this.touchTask(id, timestamp);
      this.appendEventUnchecked(id, "step-running", {
        stepId: safeStepId,
        position: step.position,
        attempt: step.attempt_count + 1,
      }, timestamp);
    });
    return this.getTask(id);
  }

  updateStepOutput(taskId: string, stepId: string, output: string): LongTask {
    const id = requireIdentifier(taskId, "长期任务 ID");
    const safeStepId = requireIdentifier(stepId, "长期任务步骤 ID");
    const normalizedOutput = optionalBoundedText(
      output,
      "长期任务步骤输出",
      MAX_LONG_TASK_STEP_OUTPUT_CHARACTERS,
    ) ?? "";
    this.transaction(() => {
      const task = this.requireTaskRow(id);
      const step = this.requireStepRow(id, safeStepId);
      if (step.status !== "running") {
        throw new Error(`只有 running 的步骤可以更新输出，当前状态为 ${step.status}。`);
      }
      const timestamp = this.nextTimestamp(task.updated_at);
      this.database.prepare(`
        UPDATE long_task_steps SET output = ? WHERE id = ? AND task_id = ?
      `).run(normalizedOutput, safeStepId, id);
      this.touchTask(id, timestamp);
      this.appendEventUnchecked(id, "step-output", {
        stepId: safeStepId,
        characterCount: normalizedOutput.length,
      }, timestamp);
    });
    return this.getTask(id);
  }

  completeStep(taskId: string, stepId: string, output?: string): LongTask {
    const id = requireIdentifier(taskId, "长期任务 ID");
    const safeStepId = requireIdentifier(stepId, "长期任务步骤 ID");
    const normalizedOutput = optionalBoundedText(
      output,
      "长期任务步骤输出",
      MAX_LONG_TASK_STEP_OUTPUT_CHARACTERS,
    );
    this.transaction(() => {
      const task = this.requireTaskRow(id);
      if (task.status !== "running") {
        throw new Error(`只有 running 的长期任务可以完成步骤，当前状态为 ${task.status}。`);
      }
      const step = this.requireStepRow(id, safeStepId);
      if (step.status === "completed") return;
      assertLongTaskStepTransition(step.status, "completed");
      const timestamp = this.nextTimestamp(task.updated_at);
      this.database.prepare(`
        UPDATE long_task_steps
        SET status = 'completed', output = COALESCE(?, output), error = NULL, completed_at = ?
        WHERE id = ? AND task_id = ?
      `).run(normalizedOutput ?? null, timestamp, safeStepId, id);
      this.database.prepare(`
        UPDATE long_tasks SET current_step = ?, updated_at = ? WHERE id = ?
      `).run(Math.min(this.stepCount(id), step.position + 1), timestamp, id);
      this.appendEventUnchecked(id, "step-completed", {
        stepId: safeStepId,
        position: step.position,
      }, timestamp);
    });
    return this.getTask(id);
  }

  failStep(taskId: string, stepId: string, error: string): LongTask {
    const id = requireIdentifier(taskId, "长期任务 ID");
    const safeStepId = requireIdentifier(stepId, "长期任务步骤 ID");
    const normalizedError = requireBoundedText(error, "长期任务步骤错误", MAX_LONG_TASK_ERROR_CHARACTERS);
    this.transaction(() => {
      const task = this.requireTaskRow(id);
      if (task.status !== "running" && task.status !== "waiting-approval") {
        throw new Error(`当前长期任务状态 ${task.status} 不能失败步骤。`);
      }
      const step = this.requireStepRow(id, safeStepId);
      assertLongTaskStepTransition(step.status, "failed");
      assertLongTaskTransition(task.status, "failed");
      const timestamp = this.nextTimestamp(task.updated_at);
      this.database.prepare(`
        UPDATE long_task_steps
        SET status = 'failed', error = ?, completed_at = ?
        WHERE id = ? AND task_id = ?
      `).run(normalizedError, timestamp, safeStepId, id);
      this.database.prepare(`
        UPDATE long_tasks
        SET status = 'failed', error = ?, updated_at = ?, completed_at = ?
        WHERE id = ?
      `).run(normalizedError, timestamp, timestamp, id);
      this.appendEventUnchecked(id, "step-failed", {
        stepId: safeStepId,
        error: normalizedError,
      }, timestamp);
      this.appendTransitionEvent(id, task.status, "failed", timestamp, {
        error: normalizedError,
      });
    });
    return this.getTask(id);
  }

  appendEvent(taskId: string, type: string, payload: unknown): StoredLongTaskEvent {
    const id = requireIdentifier(taskId, "长期任务 ID");
    let event!: StoredLongTaskEvent;
    this.transaction(() => {
      const task = this.requireTaskRow(id);
      const timestamp = this.nextTimestamp(task.updated_at);
      event = this.appendEventUnchecked(id, type, payload, timestamp);
      this.touchTask(id, timestamp);
    });
    return event;
  }

  listEvents(taskId: string, limit = DEFAULT_LONG_TASK_EVENTS_PER_TASK): StoredLongTaskEvent[] {
    const id = requireIdentifier(taskId, "长期任务 ID");
    this.requireTaskRow(id);
    const safeLimit = Math.min(this.maxEventsPerTask, Math.max(1, Math.floor(limit)));
    const rows = this.database.prepare(`
      SELECT sequence, task_id, type, payload_json, created_at
      FROM long_task_events
      WHERE task_id = ?
      ORDER BY sequence DESC
      LIMIT ?
    `).all(id, safeLimit) as unknown as LongTaskEventRow[];
    return rows.reverse().map((row) => ({
      sequence: row.sequence,
      taskId: row.task_id,
      type: row.type,
      payload: parseEventPayload(row.payload_json),
      createdAt: row.created_at,
    }));
  }

  recoverInterruptedTasks(): number {
    const placeholders = RECOVERABLE_TASK_STATUSES.map(() => "?").join(", ");
    const rows = this.database.prepare(`
      SELECT id, title, objective, status, current_step, error,
        created_at, updated_at, started_at, completed_at
      FROM long_tasks
      WHERE status IN (${placeholders})
      ORDER BY id
    `).all(...RECOVERABLE_TASK_STATUSES) as unknown as LongTaskRow[];
    if (!rows.length) return 0;

    this.transaction(() => {
      for (const row of rows) {
        assertLongTaskTransition(row.status, "interrupted");
        const timestamp = this.nextTimestamp(row.updated_at);
        this.interruptRunningStepsUnchecked(row.id);
        this.database.prepare(`
          UPDATE long_tasks
          SET status = 'interrupted', error = ?, updated_at = ?, completed_at = NULL
          WHERE id = ?
        `).run(RECOVERY_ERROR, timestamp, row.id);
        this.appendTransitionEvent(row.id, row.status, "interrupted", timestamp, {
          reason: "app-restarted",
        });
      }
    });
    return rows.length;
  }

  private initializeSchema(): void {
    const versionRow = this.database.prepare("PRAGMA user_version").get() as { user_version: number };
    if (versionRow.user_version > DATABASE_VERSION) {
      throw new Error(`长期任务数据库版本 ${versionRow.user_version} 高于当前支持版本。`);
    }
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS long_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'draft', 'queued', 'running', 'waiting-approval', 'paused',
          'interrupted', 'completed', 'failed', 'cancelled'
        )),
        current_step INTEGER NOT NULL DEFAULT 0 CHECK (current_step >= 0),
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS long_task_steps (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES long_tasks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position >= 0),
        title TEXT NOT NULL,
        instruction TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'pending', 'running', 'interrupted', 'completed', 'failed', 'cancelled'
        )),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        output TEXT,
        error TEXT,
        started_at INTEGER,
        completed_at INTEGER,
        UNIQUE(task_id, position)
      );
      CREATE INDEX IF NOT EXISTS long_task_steps_task_position
        ON long_task_steps(task_id, position);
      CREATE TABLE IF NOT EXISTS long_task_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES long_tasks(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS long_task_events_task_sequence
        ON long_task_events(task_id, sequence);
      PRAGMA user_version = ${DATABASE_VERSION};
    `);
  }

  private stopActiveTask(
    taskId: string,
    nextStatus: "paused" | "interrupted",
    reason?: string,
  ): LongTask {
    const id = requireIdentifier(taskId, "长期任务 ID");
    const normalizedReason = optionalBoundedText(reason, "长期任务暂停原因", MAX_LONG_TASK_ERROR_CHARACTERS);
    this.transaction(() => {
      const row = this.requireTaskRow(id);
      if (row.status === nextStatus) return;
      assertLongTaskTransition(row.status, nextStatus);
      const timestamp = this.nextTimestamp(row.updated_at);
      this.interruptRunningStepsUnchecked(id);
      this.database.prepare(`
        UPDATE long_tasks
        SET status = ?, error = ?, updated_at = ?, completed_at = NULL
        WHERE id = ?
      `).run(nextStatus, normalizedReason ?? null, timestamp, id);
      this.appendTransitionEvent(id, row.status, nextStatus, timestamp, {
        ...(normalizedReason === undefined ? {} : { reason: normalizedReason }),
      });
    });
    return this.getTask(id);
  }

  private failActiveStepUnchecked(taskId: string, error: string, timestamp: number): void {
    const active = this.listStepRows(taskId).find((step) =>
      step.status === "running" || step.status === "interrupted");
    if (!active) return;
    assertLongTaskStepTransition(active.status, "failed");
    this.database.prepare(`
      UPDATE long_task_steps
      SET status = 'failed', error = ?, completed_at = ?
      WHERE id = ? AND task_id = ?
    `).run(error, timestamp, active.id, taskId);
  }

  private interruptRunningStepsUnchecked(taskId: string): void {
    const running = this.listStepRows(taskId).filter((step) => step.status === "running");
    for (const step of running) assertLongTaskStepTransition(step.status, "interrupted");
    this.database.prepare(`
      UPDATE long_task_steps SET status = 'interrupted', completed_at = NULL
      WHERE task_id = ? AND status = 'running'
    `).run(taskId);
  }

  private appendTransitionEvent(
    taskId: string,
    from: LongTaskStatus,
    to: LongTaskStatus,
    timestamp: number,
    payload: Record<string, unknown> = {},
  ): StoredLongTaskEvent {
    return this.appendEventUnchecked(taskId, "task-status-changed", {
      from,
      to,
      ...payload,
    }, timestamp);
  }

  private appendEventUnchecked(
    taskId: string,
    type: string,
    payload: unknown,
    timestamp: number,
  ): StoredLongTaskEvent {
    const safeType = requireBoundedText(type, "长期任务事件类型", 80);
    const serialized = serializeEventPayload(payload);
    const result = this.database.prepare(`
      INSERT INTO long_task_events (task_id, type, payload_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(taskId, safeType, serialized, timestamp);
    this.database.prepare(`
      DELETE FROM long_task_events
      WHERE task_id = ? AND sequence NOT IN (
        SELECT sequence FROM long_task_events
        WHERE task_id = ?
        ORDER BY sequence DESC
        LIMIT ?
      )
    `).run(taskId, taskId, this.maxEventsPerTask);
    return {
      sequence: Number(result.lastInsertRowid),
      taskId,
      type: safeType,
      payload: parseEventPayload(serialized),
      createdAt: timestamp,
    };
  }

  private requireTaskRow(taskId: string): LongTaskRow {
    const row = this.database.prepare(`
      SELECT id, title, objective, status, current_step, error,
        created_at, updated_at, started_at, completed_at
      FROM long_tasks WHERE id = ?
    `).get(taskId) as unknown as LongTaskRow | undefined;
    if (!row) throw new Error("找不到指定的长期任务。");
    return row;
  }

  private requireStepRow(taskId: string, stepId: string): LongTaskStepRow {
    const row = this.database.prepare(`
      SELECT id, task_id, position, title, instruction, status, attempt_count,
        output, error, started_at, completed_at
      FROM long_task_steps WHERE task_id = ? AND id = ?
    `).get(taskId, stepId) as unknown as LongTaskStepRow | undefined;
    if (!row) throw new Error("找不到指定的长期任务步骤。");
    return row;
  }

  private listStepRows(taskId: string): LongTaskStepRow[] {
    return this.database.prepare(`
      SELECT id, task_id, position, title, instruction, status, attempt_count,
        output, error, started_at, completed_at
      FROM long_task_steps
      WHERE task_id = ?
      ORDER BY position ASC
    `).all(taskId) as unknown as LongTaskStepRow[];
  }

  private stepCount(taskId: string): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM long_task_steps WHERE task_id = ?
    `).get(taskId) as { count: number };
    return row.count;
  }

  private touchTask(taskId: string, timestamp: number): void {
    this.database.prepare("UPDATE long_tasks SET updated_at = ? WHERE id = ?")
      .run(timestamp, taskId);
  }

  private nextTimestamp(previous: number): number {
    return Math.max(this.now(), previous + 1);
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const result = operation();
      this.database.exec("COMMIT;");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }
}

function serializeEventPayload(payload: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload ?? null);
  } catch {
    throw new Error("长期任务事件内容必须可以序列化为 JSON。");
  }
  if (serialized.length > MAX_LONG_TASK_EVENT_PAYLOAD_CHARACTERS) {
    throw new Error(`长期任务事件内容不能超过 ${MAX_LONG_TASK_EVENT_PAYLOAD_CHARACTERS} 个字符。`);
  }
  return serialized;
}

function parseEventPayload(payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
}
