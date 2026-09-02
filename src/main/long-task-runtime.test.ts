import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChatEvent,
  ChatRequest,
  LongTaskEvent,
  RuntimeState,
} from "../shared/types";
import { LongTaskRuntime, type LongTaskModelRuntime } from "./long-task-runtime";
import { LongTaskStore } from "./long-task-store";

const stores: LongTaskStore[] = [];
const temporaryDirectories: string[] = [];

const readyState: RuntimeState = {
  phase: "ready",
  visionEnabled: false,
  endpoint: "http://127.0.0.1:18766",
  message: "ready",
  updatedAt: 1,
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), "desktop-pet-long-task-runtime-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "long-tasks.sqlite");
  const store = new LongTaskStore(path);
  stores.push(store);
  return { store, path };
}

function closeStore(store: LongTaskStore): void {
  store.close();
  stores.splice(stores.indexOf(store), 1);
}

function taskInput(stepCount = 1) {
  return {
    title: "长期资料任务",
    objective: "按顺序完成资料处理并保存检查点。",
    steps: Array.from({ length: stepCount }, (_, index) => ({
      title: `步骤 ${index + 1}`,
      instruction: `只执行第 ${index + 1} 个步骤。`,
    })),
  };
}

function createModel(
  handler: (
    request: ChatRequest,
    emit: (event: ChatEvent) => void,
    runKind?: "chat" | "task",
  ) => Promise<void>,
) {
  const streamChat = vi.fn(handler);
  const start = vi.fn(async () => readyState);
  const abortChat = vi.fn();
  const resolveToolApproval = vi.fn();
  const runtime: LongTaskModelRuntime = {
    snapshot: readyState,
    start,
    streamChat,
    abortChat,
    resolveToolApproval,
  };
  return { runtime, streamChat, start, abortChat, resolveToolApproval };
}

function finishWithText(text: string) {
  return async (request: ChatRequest, emit: (event: ChatEvent) => void): Promise<void> => {
    emit({ requestId: request.requestId, type: "start" });
    emit({ requestId: request.requestId, type: "delta", text });
    emit({ requestId: request.requestId, type: "done", finishReason: "stop" });
  };
}

afterEach(() => {
  while (stores.length) stores.pop()?.close();
  while (temporaryDirectories.length) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("LongTaskRuntime", () => {
  it("creates a draft, starts it explicitly, and completes one short task run", async () => {
    const { store } = createStore();
    const model = createModel(finishWithText("步骤检查点"));
    const runtime = new LongTaskRuntime(store, model.runtime);
    const events: unknown[] = [];
    runtime.on("event", (event) => events.push(event));

    const draft = runtime.createTask(taskInput());
    expect(draft.status).toBe("draft");
    expect(model.streamChat).not.toHaveBeenCalled();
    expect(runtime.startTask(draft.id).status).toBe("queued");

    await vi.waitFor(() => expect(store.getTask(draft.id).status).toBe("completed"));
    const completed = store.getTask(draft.id);
    expect(completed.steps[0]).toMatchObject({
      status: "completed",
      attemptCount: 1,
      output: "步骤检查点",
    });
    expect(model.streamChat).toHaveBeenCalledTimes(1);
    expect(model.streamChat.mock.calls[0]?.[2]).toBe("task");
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "task-updated", task: expect.objectContaining({ status: "draft" }) }),
      expect.objectContaining({ type: "task-updated", task: expect.objectContaining({ status: "completed" }) }),
    ]));
  });

  it("executes multiple steps sequentially and restores their outputs after reopening SQLite", async () => {
    const { store, path } = createStore();
    const outputs = ["第一步耐久输出", "第二步耐久输出"];
    const model = createModel(async (request, emit) => {
      const output = outputs[model.streamChat.mock.calls.length - 1]!;
      emit({ requestId: request.requestId, type: "delta", text: output });
      emit({ requestId: request.requestId, type: "done", finishReason: "stop" });
    });
    const runtime = new LongTaskRuntime(store, model.runtime);
    const task = runtime.createTask(taskInput(2));
    runtime.startTask(task.id);

    await vi.waitFor(() => expect(store.getTask(task.id).status).toBe("completed"));
    expect(model.streamChat).toHaveBeenCalledTimes(2);
    const secondPrompt = model.streamChat.mock.calls[1]?.[0].messages[0]?.content;
    expect(secondPrompt).toContain("第一步耐久输出");
    expect(store.getTask(task.id).steps.map((step) => step.output)).toEqual(outputs);

    closeStore(store);
    const reopened = new LongTaskStore(path);
    stores.push(reopened);
    expect(reopened.getTask(task.id)).toMatchObject({
      status: "completed",
      steps: [
        expect.objectContaining({ status: "completed", output: outputs[0] }),
        expect.objectContaining({ status: "completed", output: outputs[1] }),
      ],
    });
  });

  it("persists a short partial output and safely reruns after pause then immediate resume", async () => {
    const { store } = createStore();
    const firstRun = deferred();
    const firstDelta = deferred();
    const model = createModel(async (request, emit) => {
      if (model.streamChat.mock.calls.length === 1) {
        emit({ requestId: request.requestId, type: "delta", text: "不足一千字的部分输出" });
        firstDelta.resolve();
        await firstRun.promise;
        emit({ requestId: request.requestId, type: "delta", text: "不应继续写入" });
        emit({ requestId: request.requestId, type: "done", finishReason: "stop" });
        return;
      }
      emit({ requestId: request.requestId, type: "delta", text: "恢复后的最终输出" });
      emit({ requestId: request.requestId, type: "done", finishReason: "stop" });
    });
    const runtime = new LongTaskRuntime(store, model.runtime);
    const task = runtime.createTask(taskInput());
    runtime.startTask(task.id);
    await firstDelta.promise;

    const paused = runtime.pauseTask(task.id);
    expect(paused).toMatchObject({ status: "paused" });
    expect(paused.steps[0]).toMatchObject({
      status: "interrupted",
      attemptCount: 1,
      output: "不足一千字的部分输出",
    });
    expect(runtime.startTask(task.id).status).toBe("queued");
    firstRun.resolve();

    await vi.waitFor(() => expect(store.getTask(task.id).status).toBe("completed"));
    const completed = store.getTask(task.id);
    expect(completed.steps[0]).toMatchObject({
      status: "completed",
      attemptCount: 2,
      output: "恢复后的最终输出",
    });
    expect(model.streamChat).toHaveBeenCalledTimes(2);
    expect(model.streamChat.mock.calls[1]?.[0].messages[0]?.content)
      .toContain("不足一千字的部分输出");
  });

  it("tracks the exact pending tool approval and resumes only after resolving that call", async () => {
    const { store } = createStore();
    const approval = deferred<boolean>();
    const model = createModel(async (request, emit) => {
      emit({
        requestId: request.requestId,
        type: "tool-call",
        call: {
          id: "tool-call-1",
          name: "write_file",
          displayName: "写入文件",
          arguments: "{}",
          status: "pending-approval",
          requiresApproval: true,
        },
      });
      const approved = await approval.promise;
      emit({
        requestId: request.requestId,
        type: "tool-result",
        toolCallId: "tool-call-1",
        status: approved ? "completed" : "denied",
        result: approved ? "已写入" : "用户拒绝",
      });
      emit({ requestId: request.requestId, type: "delta", text: "审批后的步骤输出" });
      emit({ requestId: request.requestId, type: "done", finishReason: "stop" });
    });
    model.resolveToolApproval.mockImplementation((_requestId, toolCallId, approved) => {
      if (toolCallId === "tool-call-1") approval.resolve(approved);
    });
    const runtime = new LongTaskRuntime(store, model.runtime);
    const runtimeEvents: LongTaskEvent[] = [];
    runtime.on("event", (event: LongTaskEvent) => runtimeEvents.push(event));
    const task = runtime.createTask(taskInput());
    runtime.startTask(task.id);

    await vi.waitFor(() => expect(store.getTask(task.id).status).toBe("waiting-approval"));
    const requestId = model.streamChat.mock.calls[0]![0].requestId;
    expect(runtime.listTasks().find((item) => item.id === task.id)?.pendingApproval)
      .toMatchObject({
        requestId,
        stepId: task.steps[0]!.id,
        call: expect.objectContaining({
          id: "tool-call-1",
          name: "write_file",
          status: "pending-approval",
        }),
      });
    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "task-updated",
        task: expect.objectContaining({
          status: "waiting-approval",
          pendingApproval: expect.objectContaining({ requestId }),
        }),
      }),
    ]));
    expect(() => runtime.resolveApproval(task.id, requestId, "wrong-call", true))
      .toThrow(/工具确认已失效/);
    expect(store.getTask(task.id).status).toBe("waiting-approval");
    expect(model.resolveToolApproval).not.toHaveBeenCalled();

    runtime.resolveApproval(task.id, requestId, "tool-call-1", true);
    await vi.waitFor(() => expect(store.getTask(task.id).status).toBe("completed"));
    expect(model.resolveToolApproval).toHaveBeenCalledWith(requestId, "tool-call-1", true);
    expect(runtime.listTasks().find((item) => item.id === task.id)?.pendingApproval)
      .toBeUndefined();
    expect(store.getTask(task.id).steps[0]?.output).toBe("审批后的步骤输出");
    expect(store.listEvents(task.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "tool-approval-resolved",
        payload: { requestId, toolCallId: "tool-call-1", approved: true },
      }),
    ]));
  });

  it("clears the projected pending approval when a waiting task is paused", async () => {
    const { store } = createStore();
    const release = deferred();
    const model = createModel(async (request, emit) => {
      emit({
        requestId: request.requestId,
        type: "tool-call",
        call: {
          id: "pause-call",
          name: "write_file",
          displayName: "写入文件",
          arguments: "{\"path\":\"draft.md\"}",
          status: "pending-approval",
          requiresApproval: true,
        },
      });
      await release.promise;
    });
    const runtime = new LongTaskRuntime(store, model.runtime);
    const task = runtime.createTask(taskInput());
    runtime.startTask(task.id);
    await vi.waitFor(() => expect(store.getTask(task.id).status).toBe("waiting-approval"));
    expect(runtime.listTasks()[0]?.pendingApproval?.call.id).toBe("pause-call");

    const paused = runtime.pauseTask(task.id);
    expect(paused.status).toBe("paused");
    expect(paused.pendingApproval).toBeUndefined();
    expect(runtime.listTasks()[0]?.pendingApproval).toBeUndefined();

    const disposing = runtime.dispose();
    release.resolve();
    await disposing;
    expect(runtime.listTasks()[0]?.pendingApproval).toBeUndefined();
  });

  it("fails the active step and does not execute later steps after a model error", async () => {
    const { store } = createStore();
    const model = createModel(async (request, emit) => {
      emit({ requestId: request.requestId, type: "error", message: "模型执行失败" });
    });
    const runtime = new LongTaskRuntime(store, model.runtime);
    const task = runtime.createTask(taskInput(2));
    runtime.startTask(task.id);

    await vi.waitFor(() => expect(store.getTask(task.id).status).toBe("failed"));
    const failed = store.getTask(task.id);
    expect(failed).toMatchObject({ status: "failed", error: "模型执行失败" });
    expect(failed.steps[0]).toMatchObject({ status: "failed", error: "模型执行失败" });
    expect(failed.steps[1]?.status).toBe("pending");
    expect(model.streamChat).toHaveBeenCalledTimes(1);
  });

  it.each(["length", "content-filter", "other", "unknown"])(
    "pauses a step instead of completing it for a %s finish reason",
    async (finishReason) => {
      const { store } = createStore();
      const model = createModel(async (request, emit) => {
        emit({ requestId: request.requestId, type: "delta", text: "被截断的部分输出" });
        emit({ requestId: request.requestId, type: "done", finishReason });
      });
      const runtime = new LongTaskRuntime(store, model.runtime);
      const task = runtime.createTask(taskInput(2));
      runtime.startTask(task.id);

      await vi.waitFor(() => expect(store.getTask(task.id).status).toBe("paused"));
      const paused = store.getTask(task.id);
      expect(paused.error).toContain(`结束原因：${finishReason}`);
      expect(paused.steps[0]).toMatchObject({
        status: "interrupted",
        output: "被截断的部分输出",
      });
      expect(paused.steps[1]?.status).toBe("pending");
      expect(model.streamChat).toHaveBeenCalledTimes(1);
    },
  );

  it("persists a rejected model run as a failed task and step", async () => {
    const { store } = createStore();
    const model = createModel(async () => {
      throw new Error("模型连接中断");
    });
    const runtime = new LongTaskRuntime(store, model.runtime);
    const task = runtime.createTask(taskInput());
    runtime.startTask(task.id);

    await vi.waitFor(() => expect(store.getTask(task.id).status).toBe("failed"));
    expect(store.getTask(task.id)).toMatchObject({
      status: "failed",
      error: "模型连接中断",
      steps: [expect.objectContaining({ status: "failed", error: "模型连接中断" })],
    });
  });

  it("dispose aborts an unresolved model-start wait without starting a task stream", async () => {
    const { store } = createStore();
    const modelStart = deferred<RuntimeState>();
    const start = vi.fn(() => modelStart.promise);
    const streamChat = vi.fn(async () => undefined);
    const abortChat = vi.fn();
    const modelRuntime: LongTaskModelRuntime = {
      snapshot: { ...readyState, phase: "starting" },
      start,
      streamChat,
      abortChat,
      resolveToolApproval: vi.fn(),
    };
    const runtime = new LongTaskRuntime(store, modelRuntime);
    const task = runtime.createTask(taskInput());
    runtime.startTask(task.id);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));

    await expect(runtime.dispose()).resolves.toBeUndefined();
    expect(store.getTask(task.id).status).toBe("interrupted");
    expect(streamChat).not.toHaveBeenCalled();
    expect(abortChat).not.toHaveBeenCalled();
  });

  it("dispose interrupts active and queued tasks, checkpoints output, and never silently continues", async () => {
    const { store } = createStore();
    const release = deferred();
    const emitted = deferred();
    const model = createModel(async (request, emit) => {
      emit({ requestId: request.requestId, type: "delta", text: "退出前检查点" });
      emitted.resolve();
      await release.promise;
      emit({ requestId: request.requestId, type: "delta", text: "退出后迟到输出" });
      emit({ requestId: request.requestId, type: "done", finishReason: "stop" });
    });
    const runtime = new LongTaskRuntime(store, model.runtime);
    const active = runtime.createTask(taskInput(2));
    const queued = runtime.createTask(taskInput());
    runtime.startTask(active.id);
    runtime.startTask(queued.id);
    await emitted.promise;

    const disposing = runtime.dispose();
    expect(store.getTask(active.id)).toMatchObject({
      status: "interrupted",
      steps: [expect.objectContaining({
        status: "interrupted",
        output: "退出前检查点",
      }), expect.anything()],
    });
    expect(store.getTask(queued.id).status).toBe("interrupted");
    expect(model.abortChat).toHaveBeenCalledTimes(1);
    release.resolve();
    await disposing;

    expect(store.getTask(active.id).status).toBe("interrupted");
    expect(store.getTask(active.id).steps[0]?.output).toBe("退出前检查点");
    expect(store.getTask(active.id).steps[1]?.status).toBe("pending");
    expect(model.streamChat).toHaveBeenCalledTimes(1);
    expect(() => runtime.startTask(active.id)).toThrow(/应用正在退出/);
  });
});
