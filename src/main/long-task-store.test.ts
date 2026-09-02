import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_LONG_TASK_EVENT_PAYLOAD_CHARACTERS,
  MAX_LONG_TASK_STEP_OUTPUT_CHARACTERS,
  LongTaskStore,
} from "./long-task-store";

const stores: LongTaskStore[] = [];
const temporaryDirectories: string[] = [];

function taskInput(title = "整理项目资料") {
  return {
    title,
    objective: "把项目资料整理为可核验的结论。",
    steps: [
      { title: "收集", instruction: "收集相关本地资料。" },
      { title: "总结", instruction: "输出带来源的摘要。" },
    ],
  };
}

function createStore(options: ConstructorParameters<typeof LongTaskStore>[1] = {}) {
  const directory = mkdtempSync(join(tmpdir(), "desktop-pet-long-task-"));
  temporaryDirectories.push(directory);
  let id = 0;
  const store = new LongTaskStore(join(directory, "long-tasks.sqlite"), {
    now: () => 100,
    createId: () => `id-${++id}`,
    ...options,
  });
  stores.push(store);
  return store;
}

function closeStore(store: LongTaskStore): void {
  store.close();
  stores.splice(stores.indexOf(store), 1);
}

afterEach(() => {
  while (stores.length) stores.pop()?.close();
  while (temporaryDirectories.length) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("LongTaskStore", () => {
  it("persists a complete multi-step lifecycle with attempts, outputs, and ordered events", () => {
    const store = createStore();
    const draft = store.createTask(taskInput());
    expect(draft).toMatchObject({ status: "draft", currentStep: 0 });
    expect(draft.steps).toEqual([
      expect.objectContaining({ id: "id-2", position: 0, status: "pending", attemptCount: 0 }),
      expect.objectContaining({ id: "id-3", position: 1, status: "pending", attemptCount: 0 }),
    ]);

    store.startTask(draft.id);
    store.markTaskRunning(draft.id);
    let task = store.startStep(draft.id, draft.steps[0]!.id);
    expect(task.steps[0]).toMatchObject({ status: "running", attemptCount: 1 });
    task = store.updateStepOutput(draft.id, draft.steps[0]!.id, "已找到两份资料");
    expect(task.steps[0]?.output).toBe("已找到两份资料");
    task = store.completeStep(draft.id, draft.steps[0]!.id, "资料已收集");
    expect(task).toMatchObject({ status: "running", currentStep: 1 });
    expect(task.steps[0]).toMatchObject({ status: "completed", output: "资料已收集" });

    store.startStep(draft.id, draft.steps[1]!.id);
    store.completeStep(draft.id, draft.steps[1]!.id, "摘要已完成");
    task = store.completeTask(draft.id);
    expect(task).toMatchObject({ status: "completed", currentStep: 2 });
    expect(task.completedAt).toBeTypeOf("number");

    const events = store.listEvents(draft.id);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "task-created",
      "task-status-changed",
      "step-running",
      "step-output",
      "step-completed",
    ]));
    expect(events.map((event) => event.sequence)).toEqual(
      [...events.map((event) => event.sequence)].sort((a, b) => a - b),
    );
  });

  it("pauses an active step, resumes only explicitly, and increments its attempt", () => {
    const store = createStore();
    const task = store.createTask(taskInput());
    store.startTask(task.id);
    store.markTaskRunning(task.id);
    store.startStep(task.id, task.steps[0]!.id);

    let paused = store.pauseTask(task.id, "用户暂停");
    expect(paused).toMatchObject({ status: "paused", error: "用户暂停" });
    expect(paused.steps[0]).toMatchObject({ status: "interrupted", attemptCount: 1 });
    expect(() => store.startTask(task.id)).toThrow(/只有 draft/);
    expect(() => store.markTaskRunning(task.id)).toThrow(/不能从 paused/);

    store.resumeTask(task.id);
    store.markTaskRunning(task.id);
    paused = store.startStep(task.id, task.steps[0]!.id);
    expect(paused.steps[0]).toMatchObject({ status: "running", attemptCount: 2 });
  });

  it("recovers queued, running, and waiting-approval tasks as interrupted after reopening", () => {
    const directory = mkdtempSync(join(tmpdir(), "desktop-pet-long-task-recovery-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "long-tasks.sqlite");
    let id = 0;
    const first = new LongTaskStore(databasePath, {
      now: () => 200,
      createId: () => `recovery-${++id}`,
    });
    stores.push(first);

    const queued = first.createTask(taskInput("排队任务"));
    first.startTask(queued.id);
    const running = first.createTask(taskInput("运行任务"));
    first.startTask(running.id);
    first.markTaskRunning(running.id);
    first.startStep(running.id, running.steps[0]!.id);
    const approval = first.createTask(taskInput("审批任务"));
    first.startTask(approval.id);
    first.markTaskRunning(approval.id);
    first.startStep(approval.id, approval.steps[0]!.id);
    first.markTaskWaitingApproval(approval.id);
    const draft = first.createTask(taskInput("草稿任务"));
    closeStore(first);

    const reopened = new LongTaskStore(databasePath, { now: () => 300 });
    stores.push(reopened);
    const restored = new Map(reopened.listTasks().map((task) => [task.id, task]));
    for (const taskId of [queued.id, running.id, approval.id]) {
      expect(restored.get(taskId)).toMatchObject({
        status: "interrupted",
        error: expect.stringContaining("手动继续"),
      });
    }
    expect(restored.get(running.id)?.steps[0]?.status).toBe("interrupted");
    expect(restored.get(approval.id)?.steps[0]?.status).toBe("interrupted");
    expect(restored.get(draft.id)?.status).toBe("draft");
    expect(reopened.listEvents(approval.id).at(-1)).toMatchObject({
      type: "task-status-changed",
      payload: expect.objectContaining({
        from: "waiting-approval",
        to: "interrupted",
        reason: "app-restarted",
      }),
    });
  });

  it("rejects illegal transitions atomically and only deletes inactive tasks", () => {
    const store = createStore();
    const task = store.createTask(taskInput());
    store.startTask(task.id);
    store.markTaskRunning(task.id);
    const eventsBefore = store.listEvents(task.id);

    expect(() => store.completeTask(task.id)).toThrow(/未完成步骤/);
    expect(store.getTask(task.id).status).toBe("running");
    expect(store.listEvents(task.id)).toEqual(eventsBefore);
    expect(() => store.deleteTask(task.id)).toThrow(/请先暂停或取消/);

    const failed = store.failTask(task.id, "模型失败");
    expect(failed.status).toBe("failed");
    store.deleteTask(task.id);
    expect(store.listTasks()).toEqual([]);
  });

  it("fails a step and task in one transaction", () => {
    const store = createStore();
    const task = store.createTask(taskInput());
    store.startTask(task.id);
    store.markTaskRunning(task.id);
    store.startStep(task.id, task.steps[0]!.id);

    const failed = store.failStep(task.id, task.steps[0]!.id, "工具不可用");
    expect(failed).toMatchObject({ status: "failed", error: "工具不可用" });
    expect(failed.steps[0]).toMatchObject({ status: "failed", error: "工具不可用" });
    expect(() => store.resumeTask(task.id)).toThrow(/只有 paused 或 interrupted/);
  });

  it("bounds retained events and rejects oversized event payloads and outputs", () => {
    const store = createStore({ maxEventsPerTask: 3 });
    const task = store.createTask(taskInput());
    for (let index = 0; index < 5; index += 1) {
      store.appendEvent(task.id, `custom-${index}`, { index });
    }
    expect(store.listEvents(task.id).map((event) => event.type)).toEqual([
      "custom-2",
      "custom-3",
      "custom-4",
    ]);
    expect(() => store.appendEvent(
      task.id,
      "oversized",
      { value: "x".repeat(MAX_LONG_TASK_EVENT_PAYLOAD_CHARACTERS + 1) },
    )).toThrow(/事件内容不能超过/);

    store.startTask(task.id);
    store.markTaskRunning(task.id);
    store.startStep(task.id, task.steps[0]!.id);
    expect(() => store.updateStepOutput(
      task.id,
      task.steps[0]!.id,
      "x".repeat(MAX_LONG_TASK_STEP_OUTPUT_CHARACTERS + 1),
    )).toThrow(/步骤输出不能超过/);
    expect(store.getTask(task.id).steps[0]?.output).toBeUndefined();
  });
});
