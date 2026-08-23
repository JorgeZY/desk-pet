import type { ChatMessage } from "../../shared/types";

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
