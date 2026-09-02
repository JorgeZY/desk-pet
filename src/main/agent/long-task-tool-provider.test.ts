import { describe, expect, it, vi } from "vitest";
import type { LongTask } from "../../shared/types";
import { LongTaskToolProvider } from "./long-task-tool-provider";

function task(overrides: Partial<LongTask> = {}): LongTask {
  return {
    id: "task-1",
    title: "整理项目资料",
    objective: "整理并核验项目资料。",
    status: "draft",
    currentStep: 0,
    steps: [{
      id: "step-1",
      position: 0,
      title: "收集",
      instruction: "收集相关资料。",
      status: "pending",
      attemptCount: 0,
    }],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function executionOptions(toolCallId = "call-1") {
  return { toolCallId, messages: [], context: undefined };
}

describe("LongTaskToolProvider", () => {
  it("exposes one approval-gated create tool and two read-only tools", () => {
    const provider = new LongTaskToolProvider({
      createTask: vi.fn(() => task()),
      listTasks: vi.fn(() => []),
      getTask: vi.fn(() => task()),
    });
    expect(provider.getDescriptors().map(({ name, source, requiresApproval }) => ({
      name,
      source,
      requiresApproval,
    }))).toEqual([
      { name: "create_long_task", source: "task", requiresApproval: true },
      { name: "list_long_tasks", source: "task", requiresApproval: false },
      { name: "get_long_task", source: "task", requiresApproval: false },
    ]);
  });

  it("strictly validates and normalizes create input while only creating a draft", async () => {
    const createTask = vi.fn(() => task());
    const provider = new LongTaskToolProvider({
      createTask,
      listTasks: () => [],
      getTask: () => task(),
    });
    const execute = provider.getDescriptors()[0]?.tool.execute;
    expect(execute).toBeTypeOf("function");
    const result = await execute?.({
      title: "  整理项目资料  ",
      objective: "  整理并核验项目资料。  ",
      steps: [{ title: "  收集  ", instruction: "  收集相关资料。  " }],
    }, executionOptions());

    expect(createTask).toHaveBeenCalledWith({
      title: "整理项目资料",
      objective: "整理并核验项目资料。",
      steps: [{ title: "收集", instruction: "收集相关资料。" }],
    });
    expect(String(result)).toContain('"status":"draft"');
    expect(String(result)).toContain("尚未启动");
  });

  it("rejects malformed, unknown, and oversized create fields before writing", async () => {
    const createTask = vi.fn(() => task());
    const provider = new LongTaskToolProvider({
      createTask,
      listTasks: () => [],
      getTask: () => task(),
    });
    const execute = provider.getDescriptors()[0]!.tool.execute!;

    await expect(execute({
      title: "任务",
      objective: "目标",
      steps: [{ title: "步骤", instruction: "执行" }],
      autoStart: true,
    }, executionOptions())).rejects.toThrow(/不支持的字段：autoStart/);
    await expect(execute({
      title: "任务",
      objective: "目标",
      steps: [{ title: "步骤", instruction: "执行", command: "danger" }],
    }, executionOptions())).rejects.toThrow(/不支持的字段：command/);
    await expect(execute({
      title: " ",
      objective: "目标",
      steps: [{ title: "步骤", instruction: "执行" }],
    }, executionOptions())).rejects.toThrow(/标题不能为空/);
    expect(createTask).not.toHaveBeenCalled();
  });

  it("returns bounded summaries for list and focused current-step context for get", async () => {
    const longOutput = "结果".repeat(20_000);
    const persisted = task({
      status: "running",
      steps: [{
        id: "step-1",
        position: 0,
        title: "收集",
        instruction: "执行".repeat(4_000),
        status: "running",
        attemptCount: 2,
        output: longOutput,
      }],
    });
    const getTask = vi.fn(() => persisted);
    const provider = new LongTaskToolProvider({
      createTask: () => task(),
      listTasks: () => [persisted],
      getTask,
    });
    const [createDescriptor, listDescriptor, getDescriptor] = provider.getDescriptors();
    expect(createDescriptor).toBeDefined();

    const listed = await listDescriptor!.tool.execute!({}, executionOptions("call-list"));
    expect(String(listed)).toContain('"total":1');
    expect(String(listed)).not.toContain(longOutput);

    const details = await getDescriptor!.tool.execute!(
      { taskId: " task-1 " },
      executionOptions("call-get"),
    );
    expect(getTask).toHaveBeenCalledWith("task-1");
    expect(String(details)).toContain('"currentStepDetail"');
    expect(String(details).length).toBeLessThanOrEqual(32_000);
  });

  it("rejects arguments on list and invalid task IDs on get", async () => {
    const provider = new LongTaskToolProvider({
      createTask: () => task(),
      listTasks: () => [],
      getTask: () => task(),
    });
    const [, listDescriptor, getDescriptor] = provider.getDescriptors();
    await expect(listDescriptor!.tool.execute!(
      { status: "running" },
      executionOptions(),
    )).rejects.toThrow(/不支持的字段：status/);
    await expect(getDescriptor!.tool.execute!(
      { taskId: "" },
      executionOptions(),
    )).rejects.toThrow(/任务 ID不能为空/);
  });
});
