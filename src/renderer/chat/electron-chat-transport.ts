import type { ChatTransport, UIMessageChunk } from "ai";
import type {
  ChatEvent,
  ChatMessage,
  ChatRequest,
  ChatToolCall,
  DesktopPetApi,
  ThinkingEffort,
} from "../../shared/types";
import {
  createDesktopToolMetadata,
  desktopUIMessagesToChatMessages,
  type DesktopToolResultData,
  type DesktopUIMessage,
} from "./desktop-ui-message";

export const CONTINUATION_INSTRUCTION =
  "请直接从上一条回答结束的位置继续，不要重复已有内容。";

export interface ElectronChatTransportOptions {
  createId?: () => string;
  now?: () => number;
}

export type ElectronChatApi = Pick<
  DesktopPetApi,
  "startChat" | "abortChat" | "onChatEvent"
>;

interface DesktopChatRequestBody {
  mode: "submit" | "continue";
  thinking: boolean;
  thinkingEffort: ThinkingEffort;
}

interface ToolStreamState {
  call: ChatToolCall;
  approvalRequested: boolean;
  terminal: boolean;
}

export class ElectronChatTransport implements ChatTransport<DesktopUIMessage> {
  private readonly createId: () => string;
  private readonly now: () => number;

  constructor(
    private readonly api: ElectronChatApi,
    options: ElectronChatTransportOptions = {},
  ) {
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.now = options.now ?? Date.now;
  }

  async sendMessages(
    options: Parameters<ChatTransport<DesktopUIMessage>["sendMessages"]>[0],
  ): Promise<ReadableStream<UIMessageChunk>> {
    const body = parseRequestBody(options.body);
    const requestId = this.createId();
    const requestMessages = buildRequestMessages(
      options.messages,
      body.mode,
      this.createId,
      this.now,
    );
    const request: ChatRequest = {
      requestId,
      messages: requestMessages,
      thinking: body.thinking,
      thinkingEffort: body.thinkingEffort,
    };
    let cancelRequest: (() => void) | undefined;

    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        let closed = false;
        let requestStarted = false;
        let backendAbortSent = false;
        let unsubscribe: (() => void) | undefined;
        let textPartId: string | undefined;
        let reasoningPartId: string | undefined;
        let textPartIndex = 0;
        let reasoningPartIndex = 0;
        let warningIndex = 0;
        const tools = new Map<string, ToolStreamState>();

        const enqueue = (chunk: UIMessageChunk): void => {
          if (!closed) controller.enqueue(chunk);
        };
        const cleanup = (): void => {
          options.abortSignal?.removeEventListener("abort", handleAbort);
          unsubscribe?.();
          unsubscribe = undefined;
        };
        const close = (): void => {
          if (closed) return;
          closed = true;
          cleanup();
          controller.close();
        };
        const endText = (): void => {
          if (!textPartId) return;
          enqueue({ type: "text-end", id: textPartId });
          textPartId = undefined;
        };
        const endReasoning = (): void => {
          if (!reasoningPartId) return;
          enqueue({ type: "reasoning-end", id: reasoningPartId });
          reasoningPartId = undefined;
        };
        const endContentParts = (): void => {
          endText();
          endReasoning();
        };
        const abortBackend = (): void => {
          if (!requestStarted || backendAbortSent) return;
          backendAbortSent = true;
          this.api.abortChat(requestId);
        };
        const emitToolResultData = (
          toolCallId: string,
          status: DesktopToolResultData["status"],
          result?: string,
          error?: string,
        ): void => {
          enqueue({
            type: "data-tool-result",
            id: toolCallId,
            data: {
              toolCallId,
              status,
              resultPresent: result !== undefined,
              errorPresent: error !== undefined,
              ...(result !== undefined ? { result } : {}),
              ...(error !== undefined ? { error } : {}),
            },
          });
        };
        const emitTerminalToolState = (
          state: ToolStreamState,
          status: DesktopToolResultData["status"],
          result?: string,
          error?: string,
        ): void => {
          if (state.terminal) return;
          state.terminal = true;
          if (status === "completed") {
            enqueue({
              type: "tool-output-available",
              toolCallId: state.call.id,
              output: result ?? "",
              dynamic: true,
            });
          } else if (status === "denied") {
            enqueue({ type: "tool-output-denied", toolCallId: state.call.id });
          } else {
            enqueue({
              type: "tool-output-error",
              toolCallId: state.call.id,
              errorText: error ?? "工具执行失败。",
              dynamic: true,
            });
          }
          emitToolResultData(state.call.id, status, result, error);
        };
        const terminalizeOpenTools = (message: string): void => {
          for (const state of tools.values()) {
            if (!state.terminal) emitTerminalToolState(state, "error", undefined, message);
          }
        };
        const handleAbort = (): void => {
          abortBackend();
          if (closed) return;
          endContentParts();
          terminalizeOpenTools("任务已由用户停止。");
          enqueue({ type: "abort", reason: "已停止生成" });
          close();
        };
        cancelRequest = (): void => {
          abortBackend();
          if (closed) return;
          closed = true;
          cleanup();
        };
        const emitToolCall = (call: ChatToolCall): void => {
          endContentParts();
          let state = tools.get(call.id);
          if (!state) {
            state = { call, approvalRequested: false, terminal: false };
            tools.set(call.id, state);
            enqueue({
              type: "tool-input-available",
              toolCallId: call.id,
              toolName: call.name,
              input: parseToolInput(call.arguments),
              dynamic: true,
              title: call.displayName,
              toolMetadata: createDesktopToolMetadata({
                displayName: call.displayName,
                requiresApproval: call.requiresApproval,
                arguments: call.arguments,
                requestId,
              }),
            });
          } else {
            state.call = call;
          }

          if (call.status === "pending-approval" && !state.approvalRequested) {
            state.approvalRequested = true;
            enqueue({
              type: "tool-approval-request",
              approvalId: `${requestId}:${call.id}`,
              toolCallId: call.id,
            });
          } else if (isTerminalStatus(call.status)) {
            emitTerminalToolState(state, call.status, call.result, call.error);
          }
        };
        const handleEvent = (event: ChatEvent): void => {
          if (closed || event.requestId !== requestId) return;
          switch (event.type) {
            case "start":
              break;
            case "warning":
              warningIndex += 1;
              enqueue({
                type: "data-warning",
                id: `${requestId}:warning:${warningIndex}`,
                data: { requestId, message: event.message },
                transient: true,
              });
              break;
            case "delta":
              endReasoning();
              if (!textPartId) {
                textPartIndex += 1;
                textPartId = `${requestId}:text:${textPartIndex}`;
                enqueue({ type: "text-start", id: textPartId });
              }
              enqueue({ type: "text-delta", id: textPartId, delta: event.text });
              break;
            case "reasoning":
              endText();
              if (!reasoningPartId) {
                reasoningPartIndex += 1;
                reasoningPartId = `${requestId}:reasoning:${reasoningPartIndex}`;
                enqueue({ type: "reasoning-start", id: reasoningPartId });
              }
              enqueue({
                type: "reasoning-delta",
                id: reasoningPartId,
                delta: event.text,
              });
              break;
            case "tool-call":
              emitToolCall(event.call);
              break;
            case "tool-result": {
              endContentParts();
              const state = tools.get(event.toolCallId);
              if (state) {
                emitTerminalToolState(
                  state,
                  event.status,
                  event.result,
                  event.error,
                );
              }
              break;
            }
            case "done":
              endContentParts();
              enqueue({
                type: "finish",
                ...(event.contextUsage
                  ? { messageMetadata: { contextUsage: event.contextUsage } }
                  : {}),
              });
              close();
              break;
            case "error":
              endContentParts();
              terminalizeOpenTools(
                event.message === "已停止生成"
                  ? "任务已由用户停止。"
                  : `任务因生成错误而终止：${event.message}`,
              );
              if (event.message === "已停止生成") {
                enqueue({ type: "abort", reason: event.message });
              } else {
                enqueue({ type: "error", errorText: event.message });
              }
              close();
              break;
          }
        };

        if (options.abortSignal?.aborted) {
          closed = true;
          controller.close();
          return;
        }

        enqueue({
          type: "start",
          messageMetadata: {
            createdAt: body.mode === "continue"
              ? options.messages.at(-1)?.metadata?.createdAt ?? this.now()
              : this.now(),
            requestId,
          },
        });
        unsubscribe = this.api.onChatEvent(handleEvent);
        options.abortSignal?.addEventListener("abort", handleAbort, { once: true });
        requestStarted = true;
        try {
          this.api.startChat(request);
        } catch (error) {
          enqueue({
            type: "error",
            errorText: error instanceof Error ? error.message : String(error),
          });
          close();
        }
      },
      cancel: () => {
        cancelRequest?.();
      },
    });
  }

  async reconnectToStream(
    _options: Parameters<ChatTransport<DesktopUIMessage>["reconnectToStream"]>[0],
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    return null;
  }
}

function buildRequestMessages(
  messages: readonly DesktopUIMessage[],
  mode: DesktopChatRequestBody["mode"],
  createId: () => string,
  now: () => number,
): ChatMessage[] {
  const result = desktopUIMessagesToChatMessages(messages, now());
  // Ordered renderer parts are persisted for faithful UI restoration but are
  // redundant in the privileged runner request, which consumes normalized
  // content, attachments, reasoning, and tool calls.
  for (const message of result) delete message.parts;
  if (mode !== "continue") return result;
  const latest = result.at(-1);
  if (latest?.role !== "assistant" || !latest.content.trim()) {
    throw new Error("Only a completed assistant response can be continued.");
  }
  return [
    ...result,
    {
      id: createId(),
      role: "user",
      content: CONTINUATION_INSTRUCTION,
      createdAt: now(),
    },
  ];
}

function parseRequestBody(value: object | undefined): DesktopChatRequestBody {
  const body = isRecord(value) ? value : {};
  return {
    mode: body.mode === "continue" ? "continue" : "submit",
    thinking: body.thinking === true,
    thinkingEffort: isThinkingEffort(body.thinkingEffort)
      ? body.thinkingEffort
      : "medium",
  };
}

function isThinkingEffort(value: unknown): value is ThinkingEffort {
  return value === "minimal"
    || value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh"
    || value === "max";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function parseToolInput(value: string): unknown {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return { rawArguments: value };
  }
}

function isTerminalStatus(
  status: ChatToolCall["status"],
): status is DesktopToolResultData["status"] {
  return status === "completed" || status === "denied" || status === "error";
}
