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
