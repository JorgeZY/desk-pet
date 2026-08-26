import type { ChatMessage } from "../../shared/types";

const PANEL_UNMOUNT_CANCELLED_MESSAGE = "任务因聊天界面关闭而取消。";

export function cancelActiveGenerationForUnmount(
  requestId: string,
  assistantId: string | undefined,
  messages: ChatMessage[],
  abortChat: (requestId: string) => void,
): ChatMessage[] {
  abortChat(requestId);
  if (!assistantId) return messages;
  return terminalizeAssistantGeneration(
    assistantId,
    messages,
    "（团子停下了）",
    PANEL_UNMOUNT_CANCELLED_MESSAGE,
  );
}

export function terminalizeAssistantGeneration(
  assistantId: string,
  messages: ChatMessage[],
  fallbackContent: string,
  activeToolError: string,
): ChatMessage[] {
  return messages.map((message) => message.id === assistantId
    ? {
        ...message,
        content: message.content || fallbackContent,
        toolCalls: message.toolCalls?.map((call) => (
          call.status === "pending-approval" || call.status === "running"
            ? { ...call, status: "error" as const, error: activeToolError }
            : call
        )),
      }
    : message);
}

export function isCurrentConversationOperation(
  operationToken: number,
  currentToken: number,
): boolean {
  return operationToken === currentToken;
}

export function shouldResetComposer(
  operationStartRevision: number,
  currentRevision: number,
): boolean {
  return operationStartRevision === currentRevision;
}

export function shouldResetComposerAfterInitialization(
  composerWasEmpty: boolean,
  initializationStartRevision: number,
  currentRevision: number,
): boolean {
  return (
    composerWasEmpty &&
    shouldResetComposer(initializationStartRevision, currentRevision)
  );
}

export type ConversationOperationKind = "create" | "switch" | "delete";

export function isNearChatBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold = 36,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

export function regenerationBaseMessages(messages: ChatMessage[]): ChatMessage[] | null {
  if (messages.length < 2 || messages.at(-1)?.role !== "assistant") return null;
  const baseMessages = messages.slice(0, -1);
  return baseMessages.at(-1)?.role === "user" ? baseMessages : null;
}

export function continuationRequestMessages(
  messages: ChatMessage[],
  id: string,
  createdAt: number,
): ChatMessage[] | null {
  const latest = messages.at(-1);
  if (latest?.role !== "assistant" || !latest.content.trim()) return null;
  return [
    ...messages,
    {
      id,
      role: "user",
      content: "请直接从上一条回答结束的位置继续，不要重复已有内容。",
      createdAt,
    },
  ];
}
export type ConversationOperationPhase = "start" | "commit";

export interface ConversationOperationUiPolicy {
  closeHistory: boolean;
  focusComposer: boolean;
}

export function conversationOperationUiPolicy(
  kind: ConversationOperationKind,
  phase: ConversationOperationPhase,
): ConversationOperationUiPolicy {
  if (phase === "start" || kind === "delete") {
    return { closeHistory: false, focusComposer: false };
  }
  return { closeHistory: true, focusComposer: true };
}
