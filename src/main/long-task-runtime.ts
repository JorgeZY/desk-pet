import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  ChatEvent,
  ChatMessage,
  ChatRequest,
  LongTask,
  LongTaskCreateInput,
  LongTaskEvent,
  RuntimeState,
} from "../shared/types";
import type { LongTaskStore } from "./long-task-store";

const MODEL_READY_TIMEOUT_MS = 30 * 60 * 1_000;
const MODEL_READY_POLL_MS = 400;
const MAX_COMPLETED_CONTEXT_CHARACTERS = 12_000;
const MAX_EVENT_PAYLOAD_CHARACTERS = 12_000;
const OUTPUT_CHECKPOINT_CHARACTERS = 1_000;

export interface LongTaskModelRuntime {
  readonly snapshot: RuntimeState;
  start(allowDownload?: boolean): Promise<RuntimeState>;
  streamChat(
    request: ChatRequest,
    emit: (event: ChatEvent) => void,
    runKind?: "chat" | "task",
  ): Promise<void>;
  abortChat(requestId: string): void;
  resolveToolApproval(requestId: string, toolCallId: string, approved: boolean): void;
}

interface ActiveTaskRun {
  taskId: string;
  controller: AbortController;
  requestId?: string;
  stepId?: string;
  output: string;
}

type PendingApproval = NonNullable<LongTask["pendingApproval"]>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function bounded(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function safeEventPayload(event: ChatEvent): unknown {
  const serialized = JSON.stringify(event);
  if (serialized.length <= MAX_EVENT_PAYLOAD_CHARACTERS) return event;
  return {
    requestId: event.requestId,
    type: event.type,
    truncated: true,
    preview: bounded(serialized, MAX_EVENT_PAYLOAD_CHARACTERS),
  };
}

function buildStepPrompt(task: LongTask): string {
  const current = task.steps[task.currentStep];
  if (!current) throw new Error("长期任务没有可执行的当前步骤。");
  const completed = task.steps
    .filter((step) => step.status === "completed")
    .map((step) => `- ${step.title}: ${bounded(step.output ?? "已完成", 2_000)}`)
    .join("\n");
  const completedContext = bounded(completed, MAX_COMPLETED_CONTEXT_CHARACTERS);
  return [
    "你正在执行一个可跨重启恢复的长期任务。只处理下面的当前步骤，不要擅自执行后续步骤，也不要创建新的长期任务。",
    "可以使用已启用的知识库、builtin 或 MCP 工具；所有需要确认的工具仍必须等待用户批准。",
    "完成后返回可作为耐久检查点的简明结果：说明实际做了什么、得到什么结果、有哪些限制。不要只给计划。",
    "",
    `任务名称：${task.title}`,
    `最终目标：${task.objective}`,
    completedContext ? `已完成步骤检查点：\n${completedContext}` : "已完成步骤检查点：无",
    `当前步骤 ${current.position + 1}/${task.steps.length}：${current.title}`,
    `当前步骤指令：${current.instruction}`,
    current.output
      ? `上次中断前保存的部分输出（不要无条件重复已完成的动作）：\n${bounded(current.output, 6_000)}`
      : "",
  ].filter(Boolean).join("\n");
}

function createTaskRequest(task: LongTask, requestId: string): ChatRequest {
  const message: ChatMessage = {
    id: `${requestId}:objective`,
    role: "user",
    content: buildStepPrompt(task),
    createdAt: Date.now(),
  };
  return {
    requestId,
    messages: [message],
    thinking: true,
    thinkingEffort: "medium",
  };
}

/** Executes durable task steps as short, serialized Agent runs. SQLite remains authoritative. */
export class LongTaskRuntime extends EventEmitter {
  private executionTail: Promise<void> = Promise.resolve();
  private readonly scheduledTaskIds = new Set<string>();
  private readonly rerunTaskIds = new Set<string>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private active: ActiveTaskRun | null = null;
  private disposing = false;

  constructor(
    private readonly store: LongTaskStore,
    private readonly modelRuntime: LongTaskModelRuntime,
  ) {
    super();
  }

  listTasks(): LongTask[] {
    return this.store.listTasks().map((task) => this.projectTask(task));
  }

  createTask(input: LongTaskCreateInput): LongTask {
    this.assertAvailable();
    const task = this.store.createTask(input);
    this.emitTask(task);
    return this.projectTask(task);
  }

  startTask(taskId: string): LongTask {
    this.assertAvailable();
    const current = this.store.getTask(taskId);
    const task = current.status === "draft"
      ? this.store.startTask(taskId)
      : current.status === "paused" || current.status === "interrupted"
        ? this.store.resumeTask(taskId)
        : current.status === "queued"
          ? current
          : (() => { throw new Error(`状态为 ${current.status} 的长期任务不能开始。`); })();
    this.emitTask(task);
    this.enqueue(task.id);
    return this.projectTask(task);
  }

  pauseTask(taskId: string, reason = "用户暂停了长期任务。"): LongTask {
    const current = this.store.getTask(taskId);
    if (current.status !== "queued" && current.status !== "running" && current.status !== "waiting-approval") {
      throw new Error(`状态为 ${current.status} 的长期任务不能暂停。`);
    }
    if (this.active?.taskId === taskId) {
      this.persistActiveOutput(taskId);
      this.active.controller.abort();
      if (this.active.requestId) this.modelRuntime.abortChat(this.active.requestId);
    }
    this.clearPendingApproval(taskId);
    const task = this.store.pauseTask(taskId, reason);
    this.emitTask(task);
    return this.projectTask(task);
  }

  cancelTask(taskId: string): LongTask {
    const current = this.store.getTask(taskId);
    if (current.status === "completed" || current.status === "cancelled") {
      throw new Error(`状态为 ${current.status} 的长期任务不能取消。`);
    }
    if (this.active?.taskId === taskId) {
      this.persistActiveOutput(taskId);
      this.active.controller.abort();
      if (this.active.requestId) this.modelRuntime.abortChat(this.active.requestId);
    }
    this.clearPendingApproval(taskId);
    const task = this.store.cancelTask(taskId);
    this.emitTask(task);
    return this.projectTask(task);
  }

  deleteTask(taskId: string): void {
    if (this.scheduledTaskIds.has(taskId)) {
      throw new Error("正在排队或执行的长期任务不能删除。请等待暂停完成后重试。");
    }
    this.clearPendingApproval(taskId);
    this.store.deleteTask(taskId);
    this.emit("event", { type: "task-deleted", taskId } satisfies LongTaskEvent);
  }

  resolveApproval(
    taskId: string,
    requestId: string,
    toolCallId: string,
    approved: boolean,
  ): void {
    this.assertAvailable();
    if (
      !this.active
      || this.active.taskId !== taskId
      || this.active.requestId !== requestId
    ) {
      throw new Error("这次长期任务工具确认已失效。");
    }
    const pending = this.pendingApprovals.get(taskId);
    if (
      !pending
      || pending.requestId !== requestId
      || pending.stepId !== this.active.stepId
      || pending.call.id !== toolCallId
    ) throw new Error("这次长期任务工具确认已失效。");
    const task = this.store.getTask(taskId);
    if (task.status !== "waiting-approval") {
      throw new Error("长期任务当前没有等待工具确认。");
    }
    this.store.appendEvent(taskId, "tool-approval-resolved", {
      requestId,
      toolCallId,
      approved,
    });
    this.modelRuntime.resolveToolApproval(requestId, toolCallId, approved);
    this.clearPendingApproval(taskId);
    const running = this.store.markTaskRunning(taskId);
    this.emitTask(running);
  }

  async dispose(): Promise<void> {
    if (this.disposing) return this.executionTail;
    this.disposing = true;
    if (this.active) {
      this.persistActiveOutput(this.active.taskId);
      this.active.controller.abort();
      if (this.active.requestId) this.modelRuntime.abortChat(this.active.requestId);
    }
    for (const task of this.store.listTasks()) {
      if (task.status !== "queued" && task.status !== "running" && task.status !== "waiting-approval") {
        continue;
      }
      this.clearPendingApproval(task.id);
      const interrupted = this.store.interruptTask(task.id, "应用正在退出；任务已保存为可手动继续的中断状态。");
      this.emitTask(interrupted);
    }
    this.pendingApprovals.clear();
    await this.executionTail.catch(() => undefined);
  }

  private assertAvailable(): void {
    if (this.disposing) throw new Error("应用正在退出，不能创建或启动长期任务。");
  }

  private enqueue(taskId: string): void {
    if (this.scheduledTaskIds.has(taskId)) {
      this.rerunTaskIds.add(taskId);
      return;
    }
    this.scheduledTaskIds.add(taskId);
    const operation = this.executionTail.then(() => this.execute(taskId));
    this.executionTail = operation.catch((error) => {
      console.error(`[long-task:${taskId}] execution failed:`, error);
    }).finally(() => {
      this.scheduledTaskIds.delete(taskId);
      const rerun = this.rerunTaskIds.delete(taskId);
      if (rerun && !this.disposing && this.store.getTask(taskId).status === "queued") {
        this.enqueue(taskId);
      }
    });
  }

  private async execute(taskId: string): Promise<void> {
    if (this.disposing) return;
    let task = this.store.getTask(taskId);
    if (task.status !== "queued") return;

    const controller = new AbortController();
    this.active = { taskId, controller, output: "" };
    try {
      await this.ensureModelReady(controller.signal);
      if (controller.signal.aborted || this.store.getTask(taskId).status !== "queued") return;
      task = this.store.markTaskRunning(taskId);
      this.emitTask(task);

      while (!controller.signal.aborted) {
        task = this.store.getTask(taskId);
        if (task.status !== "running") return;
        const step = task.steps[task.currentStep];
        if (!step) {
          this.clearPendingApproval(taskId);
          this.emitTask(this.store.completeTask(taskId));
          return;
        }

        task = this.store.startStep(taskId, step.id);
        this.emitTask(task);
        const runningStep = task.steps[task.currentStep]!;
        const requestId = `long-task:${taskId}:${runningStep.id}:${runningStep.attemptCount}:${randomUUID()}`;
        this.active.requestId = requestId;
        this.active.stepId = runningStep.id;
        this.active.output = "";
        this.clearPendingApproval(taskId);
        const request = createTaskRequest(task, requestId);
        let output = "";
        let persistedCharacters = 0;
        let finalError = "";
        let finishReason: string | undefined;

        await this.modelRuntime.streamChat(request, (event) => {
          if (
            controller.signal.aborted
            || this.disposing
            || this.active?.controller !== controller
            || this.active.requestId !== requestId
          ) return;
          if (event.type === "delta") {
            output += event.text;
            this.active.output = output;
            if (output.length - persistedCharacters >= OUTPUT_CHECKPOINT_CHARACTERS) {
              const latest = this.store.getTask(taskId);
              if (latest.status === "running") {
                persistedCharacters = output.length;
                this.emitTask(this.store.updateStepOutput(taskId, runningStep.id, output));
              }
            }
          }
          if (event.type === "error") finalError = event.message;
          if (event.type === "done") finishReason = event.finishReason;
          if (event.type === "tool-call" && event.call.status === "pending-approval") {
            const latest = this.store.getTask(taskId);
            if (latest.status === "running") {
              this.pendingApprovals.set(taskId, {
                requestId,
                stepId: runningStep.id,
                call: { ...event.call },
              });
              const waiting = this.store.markTaskWaitingApproval(taskId);
              this.emitTask(waiting);
            }
          }
          if (
            event.type === "tool-result"
            && this.pendingApprovals.get(taskId)?.call.id === event.toolCallId
          ) {
            this.clearPendingApproval(taskId);
          }
          if (
            event.type === "warning"
            || event.type === "tool-call"
            || event.type === "tool-result"
            || event.type === "done"
            || event.type === "error"
          ) {
            this.store.appendEvent(taskId, `agent-${event.type}`, safeEventPayload(event));
          }
          this.emit("event", {
            type: "chat-event",
            taskId,
            stepId: runningStep.id,
            event,
          } satisfies LongTaskEvent);
        }, "task");
        this.active.requestId = undefined;

        const latest = this.store.getTask(taskId);
        if (controller.signal.aborted || this.disposing) return;
        if (
          finalError
          && (latest.status === "running" || latest.status === "waiting-approval")
        ) {
          this.clearPendingApproval(taskId);
          this.emitTask(this.store.failStep(taskId, runningStep.id, finalError));
          return;
        }
        if (latest.status !== "running") return;
        if (finishReason === "length") {
          this.persistActiveOutput(taskId);
          this.clearPendingApproval(taskId);
          this.emitTask(this.store.pauseTask(
            taskId,
            "模型输出达到长度上限，当前步骤已保存但未完成。请提高最大输出长度后继续。",
          ));
          return;
        }
        this.clearPendingApproval(taskId);
        const checkpoint = output.trim()
          || runningStep.output?.trim()
          || "步骤执行完成，但模型没有返回文字检查点。";
        task = this.store.completeStep(taskId, runningStep.id, checkpoint);
        this.emitTask(task);
        if (task.currentStep >= task.steps.length) {
          this.clearPendingApproval(taskId);
          this.emitTask(this.store.completeTask(taskId));
          return;
        }
        await Promise.resolve();
      }
    } catch (error) {
      if (controller.signal.aborted || this.disposing) return;
      const latest = this.store.getTask(taskId);
      if (
        latest.status !== "paused"
        && latest.status !== "interrupted"
        && latest.status !== "cancelled"
        && latest.status !== "completed"
        && latest.status !== "failed"
      ) {
        const message = errorMessage(error).trim() || "长期任务执行失败。";
        this.clearPendingApproval(taskId);
        this.emitTask(this.store.failTask(taskId, bounded(message, 4_000)));
      }
    } finally {
      if (this.active?.taskId === taskId) this.active = null;
    }
  }

  private async ensureModelReady(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.modelRuntime.snapshot.phase !== "ready") {
      await waitWithAbort(this.modelRuntime.start(true), signal);
    }
    const startedAt = Date.now();
    while (this.modelRuntime.snapshot.phase !== "ready") {
      signal.throwIfAborted();
      const state = this.modelRuntime.snapshot;
      if (state.phase === "error") throw new Error(state.error ?? state.message);
      if (Date.now() - startedAt >= MODEL_READY_TIMEOUT_MS) {
        throw new Error("聊天模型在 30 分钟内未能就绪，长期任务没有开始执行。");
      }
      await delay(MODEL_READY_POLL_MS, signal);
    }
  }

  private emitTask(task: LongTask): void {
    this.emit("event", {
      type: "task-updated",
      task: this.projectTask(task),
    } satisfies LongTaskEvent);
  }

  private projectTask(task: LongTask): LongTask {
    const { pendingApproval: _ignored, ...durableTask } = task;
    const pending = task.status === "waiting-approval"
      ? this.pendingApprovals.get(task.id)
      : undefined;
    return pending
      ? {
          ...durableTask,
          pendingApproval: {
            requestId: pending.requestId,
            stepId: pending.stepId,
            call: { ...pending.call },
          },
        }
      : durableTask;
  }

  private clearPendingApproval(taskId: string): void {
    this.pendingApprovals.delete(taskId);
  }

  private persistActiveOutput(taskId: string): void {
    const active = this.active;
    if (!active || active.taskId !== taskId || !active.stepId || !active.output) return;
    const task = this.store.getTask(taskId);
    const step = task.steps.find((item) => item.id === active.stepId);
    if (
      (task.status !== "running" && task.status !== "waiting-approval")
      || step?.status !== "running"
      || step.output === active.output
    ) return;
    this.emitTask(this.store.updateStepOutput(taskId, active.stepId, active.output));
  }
}

function waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}
