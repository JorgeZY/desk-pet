// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopPetApi,
  LongTask,
  LongTaskCreateInput,
  LongTaskEvent,
  LongTaskStatus,
  LongTaskStep,
  LongTaskStepStatus,
} from "../../shared/types";
import { LongTaskPanel } from "./LongTaskPanel";

function step(
  taskId: string,
  position: number,
  status: LongTaskStepStatus = "pending",
  overrides: Partial<LongTaskStep> = {},
): LongTaskStep {
  return {
    id: `${taskId}-step-${position + 1}`,
    position,
    title: `步骤 ${position + 1}`,
    instruction: `执行第 ${position + 1} 步`,
    status,
    attemptCount: status === "pending" ? 0 : 1,
    ...overrides,
  };
}

function task(
  id: string,
  status: LongTaskStatus = "draft",
  overrides: Partial<LongTask> = {},
): LongTask {
  return {
    id,
    title: `${id} 任务`,
    objective: `${id} 的最终目标`,
    status,
    currentStep: 0,
    steps: [step(id, 0)],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function installDesktopPet(initialTasks: LongTask[] = []) {
  let eventListener: ((event: LongTaskEvent) => void) | undefined;
  const unsubscribe = vi.fn();
  const tasksById = new Map(initialTasks.map((item) => [item.id, item]));
  const transition = (taskId: string, status: LongTaskStatus): LongTask => {
    const current = tasksById.get(taskId) ?? task(taskId);
    const updated = { ...current, status, updatedAt: current.updatedAt + 1 };
    tasksById.set(taskId, updated);
    return updated;
  };
  const api = {
    listLongTasks: vi.fn(async () => initialTasks),
    createLongTask: vi.fn(async (input: LongTaskCreateInput) => {
      const created = task("created", "draft", {
        title: input.title,
        objective: input.objective,
        steps: input.steps.map((item, position) => step("created", position, "pending", item)),
        updatedAt: 1_700_000_000_100,
      });
      tasksById.set(created.id, created);
      return created;
    }),
    startLongTask: vi.fn(async (taskId: string) => transition(taskId, "queued")),
    pauseLongTask: vi.fn(async (taskId: string) => transition(taskId, "paused")),
    cancelLongTask: vi.fn(async (taskId: string) => transition(taskId, "cancelled")),
    deleteLongTask: vi.fn(async () => undefined),
    resolveLongTaskApproval: vi.fn(),
    onLongTaskEvent: vi.fn((listener: (event: LongTaskEvent) => void) => {
      eventListener = listener;
      return unsubscribe;
    }),
  };
  Object.defineProperty(window, "desktopPet", {
    configurable: true,
    value: api as unknown as DesktopPetApi,
  });
  return {
    api,
    emit: (event: LongTaskEvent) => act(() => eventListener?.(event)),
    unsubscribe,
  };
}

const lifecycleActionCases: Array<[
  LongTaskStatus,
  readonly ("开始任务" | "继续任务" | "暂停" | "取消任务" | "删除")[],
]> = [
  ["draft", ["开始任务", "删除"]],
  ["queued", ["暂停", "取消任务"]],
  ["running", ["暂停", "取消任务"]],
  ["waiting-approval", ["暂停", "取消任务"]],
  ["paused", ["继续任务", "取消任务"]],
  ["interrupted", ["继续任务", "取消任务"]],
  ["completed", ["删除"]],
  ["failed", ["删除"]],
  ["cancelled", ["删除"]],
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("LongTaskPanel", () => {
  it("shows the empty state and creates a normalized task payload", async () => {
    const user = userEvent.setup();
    const { api } = installDesktopPet();
    render(<LongTaskPanel onClose={vi.fn()} />);

    expect(await screen.findByText("暂无长期任务")).toBeTruthy();
    expect(screen.getByText("创建或选择一个长期任务")).toBeTruthy();

    await user.type(screen.getByLabelText("任务名称"), "  整理发布说明  ");
    await user.type(screen.getByLabelText("最终目标"), "  生成可审阅的发布说明  ");
    fireEvent.change(screen.getByLabelText("执行步骤（每行一个）"), {
      target: {
        value: "收集资料：检索本地文档\n生成草稿\n验证结果：检查：遗漏",
      },
    });
    await user.click(screen.getByRole("button", { name: "创建任务草稿" }));

    await waitFor(() => {
      expect(api.createLongTask).toHaveBeenCalledWith({
        title: "整理发布说明",
        objective: "生成可审阅的发布说明",
        steps: [
          { title: "收集资料", instruction: "检索本地文档" },
          { title: "步骤 2", instruction: "生成草稿" },
          { title: "验证结果", instruction: "检查：遗漏" },
        ],
      });
    });
    expect(await screen.findByRole("heading", { name: "整理发布说明" })).toBeTruthy();
    expect((screen.getByLabelText("任务名称") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("最终目标") as HTMLTextAreaElement).value).toBe("");
    expect((screen.getByLabelText("执行步骤（每行一个）") as HTMLTextAreaElement).value)
      .toBe("");
  });

  it("selects tasks and renders completed-step progress", async () => {
    const user = userEvent.setup();
    const first = task("首个", "running", {
      title: "首个任务",
      steps: [
        step("first", 0, "completed", { title: "已完成步骤" }),
        step("first", 1, "running", { title: "执行中步骤" }),
      ],
    });
    const second = task("第二个", "completed", {
      title: "第二个任务",
      updatedAt: first.updatedAt + 1,
      steps: [step("second", 0, "completed", { title: "唯一步骤" })],
    });
    installDesktopPet([first, second]);
    render(<LongTaskPanel onClose={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "首个任务" })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "长期任务进度" }).getAttribute("aria-valuenow"))
      .toBe("50");
    expect(screen.getByText("1. 已完成步骤")).toBeTruthy();
    expect(screen.getByText("2. 执行中步骤")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /第二个任务.*已完成/u }));

    expect(await screen.findByRole("heading", { name: "第二个任务" })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "长期任务进度" }).getAttribute("aria-valuenow"))
      .toBe("100");
  });

  it.each(lifecycleActionCases)(
    "shows only legal lifecycle buttons for %s",
    async (status, expectedActions) => {
      installDesktopPet([task(status, status, { title: `状态 ${status}` })]);
      render(<LongTaskPanel onClose={vi.fn()} />);
      expect(await screen.findByRole("heading", { name: `状态 ${status}` })).toBeTruthy();

      const actionNames = ["开始任务", "继续任务", "暂停", "取消任务", "删除"] as const;
      for (const actionName of actionNames) {
        if (expectedActions.includes(actionName)) {
          expect(screen.getByRole("button", { name: actionName })).toBeTruthy();
        } else {
          expect(screen.queryByRole("button", { name: actionName })).toBeNull();
        }
      }
    },
  );

  it("exposes only legal lifecycle actions and forwards each mutation", async () => {
    const user = userEvent.setup();
    const draft = task("草稿", "draft", { title: "草稿任务", updatedAt: 4 });
    const running = task("运行", "running", { title: "运行任务", updatedAt: 3 });
    const paused = task("暂停", "paused", { title: "暂停任务", updatedAt: 2 });
    const completed = task("完成", "completed", { title: "完成任务", updatedAt: 1 });
    const { api } = installDesktopPet([draft, running, paused, completed]);
    render(<LongTaskPanel onClose={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "草稿任务" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "开始任务" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "暂停" })).toBeNull();
    expect(screen.queryByRole("button", { name: "取消任务" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "开始任务" }));
    await waitFor(() => expect(api.startLongTask).toHaveBeenCalledWith(draft.id));

    await user.click(screen.getByRole("button", { name: /运行任务.*执行中/u }));
    expect(await screen.findByRole("heading", { name: "运行任务" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "暂停" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消任务" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(api.pauseLongTask).toHaveBeenCalledWith(running.id));

    await user.click(screen.getByRole("button", { name: /暂停任务.*已暂停/u }));
    expect(await screen.findByRole("heading", { name: "暂停任务" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "继续任务" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消任务" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "取消任务" }));
    await waitFor(() => expect(api.cancelLongTask).toHaveBeenCalledWith(paused.id));

    await user.click(screen.getByRole("button", { name: /完成任务.*已完成/u }));
    expect(await screen.findByRole("heading", { name: "完成任务" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "开始任务" })).toBeNull();
    expect(screen.queryByRole("button", { name: "暂停" })).toBeNull();
    expect(screen.queryByRole("button", { name: "取消任务" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(api.deleteLongTask).toHaveBeenCalledWith(completed.id));
  });

  it("applies task-updated events to status, steps, output, and progress", async () => {
    const original = task("event", "paused", {
      title: "事件任务",
      steps: [step("event", 0), step("event", 1)],
    });
    const { emit } = installDesktopPet([original]);
    render(<LongTaskPanel onClose={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "事件任务" })).toBeTruthy();

    emit({
      type: "task-updated",
      task: {
        ...original,
        status: "running",
        updatedAt: original.updatedAt + 1,
        steps: [
          step("event", 0, "completed", { output: "事件输出" }),
          step("event", 1, "running"),
        ],
      },
    });

    await waitFor(() => {
      expect(screen.getByRole("progressbar", { name: "长期任务进度" }).getAttribute("aria-valuenow"))
        .toBe("50");
    });
    expect(screen.getAllByText("执行中").length).toBeGreaterThan(0);
    expect(screen.getByText("事件输出")).toBeTruthy();
    expect(screen.getByRole("button", { name: "暂停" })).toBeTruthy();
  });

  it("shows a failed step error without hiding its saved partial output", async () => {
    const failed = task("failed-output", "failed", {
      title: "失败输出任务",
      error: "模型连接中断",
      steps: [step("failed-output", 0, "failed", {
        error: "模型连接中断",
        output: "断开前保存的部分结果",
      })],
    });
    installDesktopPet([failed]);

    render(<LongTaskPanel onClose={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "失败输出任务" })).toBeTruthy();
    expect(screen.getAllByText("模型连接中断").length).toBeGreaterThan(0);
    expect(screen.getByText("断开前保存的部分结果")).toBeTruthy();
  });

  it("isolates streamed output by task step and keeps the active stream ahead of checkpoints", async () => {
    const running = task("streamed", "running", {
      steps: [
        step("streamed", 0, "running"),
        step("streamed", 1),
      ],
    });
    const { emit } = installDesktopPet([running]);
    render(<LongTaskPanel onClose={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "streamed 任务" })).toBeTruthy();

    emit({
      type: "chat-event",
      taskId: running.id,
      stepId: running.steps[0]!.id,
      event: { requestId: "request-step-1", type: "delta", text: "第一步实时输出" },
    });
    expect(screen.getByText("第一步实时输出")).toBeTruthy();

    emit({
      type: "task-updated",
      task: {
        ...running,
        currentStep: 1,
        updatedAt: running.updatedAt + 1,
        steps: [
          step("streamed", 0, "completed", { output: "第一步最终输出" }),
          step("streamed", 1, "running"),
        ],
      },
    });
    const secondStepCard = () => screen.getByText("2. 步骤 2").closest('[data-slot="card"]');
    expect(secondStepCard()?.textContent).not.toContain("第一步实时输出");

    emit({
      type: "chat-event",
      taskId: running.id,
      stepId: running.steps[1]!.id,
      event: { requestId: "request-step-2", type: "delta", text: "第二步实时输出" },
    });
    expect(secondStepCard()?.textContent).toContain("第二步实时输出");
    expect(secondStepCard()?.textContent).not.toContain("第一步实时输出");

    emit({
      type: "task-updated",
      task: {
        ...running,
        currentStep: 1,
        updatedAt: running.updatedAt + 2,
        steps: [
          step("streamed", 0, "completed", { output: "第一步最终输出" }),
          step("streamed", 1, "running", { output: "第二步检查点" }),
        ],
      },
    });
    emit({
      type: "chat-event",
      taskId: running.id,
      stepId: running.steps[1]!.id,
      event: { requestId: "request-step-2", type: "delta", text: "，继续生成" },
    });
    expect(secondStepCard()?.textContent).toContain("第二步实时输出，继续生成");
    expect(secondStepCard()?.textContent).not.toContain("第二步检查点");

    emit({
      type: "task-updated",
      task: {
        ...running,
        status: "completed",
        currentStep: 2,
        updatedAt: running.updatedAt + 3,
        completedAt: running.updatedAt + 3,
        steps: [
          step("streamed", 0, "completed", { output: "第一步最终输出" }),
          step("streamed", 1, "completed", { output: "第二步最终输出" }),
        ],
      },
    });
    expect(secondStepCard()?.textContent).toContain("第二步最终输出");
    expect(secondStepCard()?.textContent).not.toContain("第二步实时输出");
  });

  it("resolves pending tool approval events as allow or deny", async () => {
    const user = userEvent.setup();
    const waiting = task("approval", "waiting-approval", { title: "审批任务" });
    const { api, emit } = installDesktopPet([waiting]);
    render(<LongTaskPanel onClose={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "审批任务" })).toBeTruthy();

    const approvalEvent = (requestId: string, callId: string): LongTaskEvent => ({
      type: "chat-event",
      taskId: waiting.id,
      stepId: waiting.steps[0]!.id,
      event: {
        requestId,
        type: "tool-call",
        call: {
          id: callId,
          name: "write_file",
          displayName: "写入文件",
          arguments: "{\"path\":\"README.md\"}",
          status: "pending-approval",
          requiresApproval: true,
        },
      },
    });

    emit(approvalEvent("request-allow", "call-allow"));
    expect(await screen.findByText("工具需要你的确认：写入文件")).toBeTruthy();
    expect(screen.getByText("{\"path\":\"README.md\"}")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "允许一次" }));
    expect(api.resolveLongTaskApproval).toHaveBeenCalledWith(
      waiting.id,
      "request-allow",
      "call-allow",
      true,
    );
    expect(screen.queryByRole("button", { name: "允许一次" })).toBeNull();

    emit(approvalEvent("request-deny", "call-deny"));
    await user.click(await screen.findByRole("button", { name: "拒绝" }));
    expect(api.resolveLongTaskApproval).toHaveBeenCalledWith(
      waiting.id,
      "request-deny",
      "call-deny",
      false,
    );
    expect(screen.queryByRole("button", { name: "拒绝" })).toBeNull();
  });

  it("restores a pending approval from the initial durable-task projection", async () => {
    const user = userEvent.setup();
    const waiting = task("restored-approval", "waiting-approval", {
      title: "重新打开的审批任务",
      pendingApproval: {
        requestId: "request-restored",
        stepId: "restored-approval-step-1",
        call: {
          id: "call-restored",
          name: "write_file",
          displayName: "写入文件",
          arguments: "{\"path\":\"CHANGELOG.md\"}",
          status: "pending-approval",
          requiresApproval: true,
        },
      },
    });
    const { api } = installDesktopPet([waiting]);
    render(<LongTaskPanel onClose={vi.fn()} />);

    expect(await screen.findByText("工具需要你的确认：写入文件")).toBeTruthy();
    expect(screen.getByText("{\"path\":\"CHANGELOG.md\"}")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "允许一次" }));
    expect(api.resolveLongTaskApproval).toHaveBeenCalledWith(
      waiting.id,
      "request-restored",
      "call-restored",
      true,
    );
  });
});
