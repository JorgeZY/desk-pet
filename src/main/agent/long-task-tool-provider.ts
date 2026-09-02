import { dynamicTool, jsonSchema } from "ai";
import type { LongTask, LongTaskCreateInput } from "../../shared/types";
import {
  MAX_LONG_TASK_OBJECTIVE_CHARACTERS,
  MAX_LONG_TASK_STEPS,
  MAX_LONG_TASK_STEP_INSTRUCTION_CHARACTERS,
  MAX_LONG_TASK_STEP_TITLE_CHARACTERS,
  MAX_LONG_TASK_TITLE_CHARACTERS,
} from "../long-task-store";
import type { AgentToolDescriptor, ToolProvider } from "./tool-provider";

const MAX_TOOL_TEXT_CHARACTERS = 32_000;
const MAX_TOOL_OBJECTIVE_CHARACTERS = 2_000;
const MAX_TOOL_INSTRUCTION_CHARACTERS = 4_000;
const MAX_TOOL_OUTPUT_CHARACTERS = 4_000;
const MAX_TOOL_ERROR_CHARACTERS = 1_000;
const MAX_LISTED_TASKS = 50;

export interface LongTaskToolStore {
  createTask(input: LongTaskCreateInput): LongTask;
  listTasks(): LongTask[];
  getTask(taskId: string): LongTask;
}

export class LongTaskToolProvider implements ToolProvider {
  private readonly descriptors: AgentToolDescriptor[];

  constructor(private readonly store: LongTaskToolStore) {
    this.descriptors = [
      {
        name: "create_long_task",
        displayName: "创建长期任务草稿",
        source: "task",
        requiresApproval: true,
        metadata: { kind: "long-task", operation: "create", readOnly: false },
        tool: dynamicTool({
          title: "创建长期任务草稿",
          description: [
            "把需要分步骤、可暂停并在应用重启后恢复的工作保存为长期任务草稿。",
            "此工具只创建 draft，不会自动启动；创建前必须获得用户确认。",
          ].join(""),
          inputSchema: jsonSchema({
            type: "object",
            properties: {
              title: {
                type: "string",
                minLength: 1,
                maxLength: MAX_LONG_TASK_TITLE_CHARACTERS,
                description: "简洁、可辨认的任务标题。",
              },
              objective: {
                type: "string",
                minLength: 1,
                maxLength: MAX_LONG_TASK_OBJECTIVE_CHARACTERS,
                description: "任务最终需要达成的可验证目标。",
              },
              steps: {
                type: "array",
                minItems: 1,
                maxItems: MAX_LONG_TASK_STEPS,
                items: {
                  type: "object",
                  properties: {
                    title: {
                      type: "string",
                      minLength: 1,
                      maxLength: MAX_LONG_TASK_STEP_TITLE_CHARACTERS,
                    },
                    instruction: {
                      type: "string",
                      minLength: 1,
                      maxLength: MAX_LONG_TASK_STEP_INSTRUCTION_CHARACTERS,
                    },
                  },
                  required: ["title", "instruction"],
                  additionalProperties: false,
                },
              },
            },
            required: ["title", "objective", "steps"],
            additionalProperties: false,
          }),
          execute: async (input) => this.create(input),
        }),
      },
      {
        name: "list_long_tasks",
        displayName: "列出长期任务",
        source: "task",
        requiresApproval: false,
        metadata: { kind: "long-task", operation: "list", readOnly: true },
        tool: dynamicTool({
          title: "列出长期任务",
          description: "列出已经持久化的长期任务及其当前状态，不执行或修改任务。",
          inputSchema: jsonSchema({
            type: "object",
            properties: {},
            additionalProperties: false,
          }),
          execute: async (input) => this.list(input),
        }),
      },
      {
        name: "get_long_task",
        displayName: "读取长期任务",
        source: "task",
        requiresApproval: false,
        metadata: { kind: "long-task", operation: "get", readOnly: true },
        tool: dynamicTool({
          title: "读取长期任务",
          description: "读取一个长期任务的目标、步骤状态及当前步骤上下文，不执行或修改任务。",
          inputSchema: jsonSchema({
            type: "object",
            properties: {
              taskId: {
                type: "string",
                minLength: 1,
                maxLength: 128,
                description: "长期任务 ID。",
              },
            },
            required: ["taskId"],
            additionalProperties: false,
          }),
          execute: async (input) => this.get(input),
        }),
      },
    ];
  }

  async start(): Promise<void> {}

  getDescriptors(): readonly AgentToolDescriptor[] {
    return [...this.descriptors];
  }

  async close(): Promise<void> {}

  private create(input: unknown): string {
    const value = requireStrictObject(input, ["title", "objective", "steps"], "创建长期任务参数");
    const stepsValue = value.steps;
    if (!Array.isArray(stepsValue) || stepsValue.length < 1) {
      throw new Error("长期任务至少需要一个步骤。");
    }
    if (stepsValue.length > MAX_LONG_TASK_STEPS) {
      throw new Error(`长期任务最多包含 ${MAX_LONG_TASK_STEPS} 个步骤。`);
    }
    const task = this.store.createTask({
      title: requireToolText(value.title, "长期任务标题", MAX_LONG_TASK_TITLE_CHARACTERS),
      objective: requireToolText(
        value.objective,
        "长期任务目标",
        MAX_LONG_TASK_OBJECTIVE_CHARACTERS,
      ),
      steps: stepsValue.map((step, index) => {
        const item = requireStrictObject(
          step,
          ["title", "instruction"],
          `长期任务步骤 ${index + 1}`,
        );
        return {
          title: requireToolText(
            item.title,
            `长期任务步骤 ${index + 1} 标题`,
            MAX_LONG_TASK_STEP_TITLE_CHARACTERS,
          ),
          instruction: requireToolText(
            item.instruction,
            `长期任务步骤 ${index + 1} 指令`,
            MAX_LONG_TASK_STEP_INSTRUCTION_CHARACTERS,
          ),
        };
      }),
    });
    return boundedJson({
      id: task.id,
      title: task.title,
      status: task.status,
      stepCount: task.steps.length,
      message: "长期任务草稿已保存，尚未启动。",
    });
  }

  private list(input: unknown): string {
    requireStrictObject(input, [], "列出长期任务参数");
    const tasks = this.store.listTasks();
    return boundedJson({
      total: tasks.length,
      tasks: tasks.slice(0, MAX_LISTED_TASKS).map(taskSummary),
      omitted: Math.max(0, tasks.length - MAX_LISTED_TASKS),
    });
  }

  private get(input: unknown): string {
    const value = requireStrictObject(input, ["taskId"], "读取长期任务参数");
    const taskId = requireToolText(value.taskId, "长期任务 ID", 128);
    const task = this.store.getTask(taskId);
    const current = task.steps[task.currentStep];
    return boundedJson({
      ...taskSummary(task),
      objective: truncate(task.objective, MAX_TOOL_OBJECTIVE_CHARACTERS),
      error: task.error ? truncate(task.error, MAX_TOOL_ERROR_CHARACTERS) : undefined,
      steps: task.steps.map((step) => ({
        id: step.id,
        position: step.position,
        title: step.title,
        status: step.status,
        attemptCount: step.attemptCount,
      })),
      currentStepDetail: current ? {
        id: current.id,
        position: current.position,
        title: current.title,
        instruction: truncate(current.instruction, MAX_TOOL_INSTRUCTION_CHARACTERS),
        status: current.status,
        attemptCount: current.attemptCount,
        output: current.output ? truncate(current.output, MAX_TOOL_OUTPUT_CHARACTERS) : undefined,
        error: current.error ? truncate(current.error, MAX_TOOL_ERROR_CHARACTERS) : undefined,
      } : undefined,
    });
  }
}

function taskSummary(task: LongTask): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    currentStep: task.currentStep,
    stepCount: task.steps.length,
    updatedAt: task.updatedAt,
  };
}

function requireStrictObject(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}必须是对象。`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label}必须是普通对象。`);
  }
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) throw new Error(`${label}包含不支持的字段：${unexpected}。`);
  return value as Record<string, unknown>;
}

function requireToolText(value: unknown, label: string, maxCharacters: number): string {
  if (typeof value !== "string") throw new Error(`${label}必须是字符串。`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}不能为空。`);
  if (normalized.length > maxCharacters) {
    throw new Error(`${label}不能超过 ${maxCharacters} 个字符。`);
  }
  return normalized;
}

function truncate(value: string, maxCharacters: number): string {
  return value.length <= maxCharacters
    ? value
    : `${value.slice(0, Math.max(0, maxCharacters - 1))}…`;
}

function boundedJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized.length <= MAX_TOOL_TEXT_CHARACTERS
    ? serialized
    : JSON.stringify({
        truncated: true,
        preview: truncate(serialized, MAX_TOOL_TEXT_CHARACTERS - 64),
      });
}
