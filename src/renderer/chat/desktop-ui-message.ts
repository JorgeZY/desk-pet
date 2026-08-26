import type { DynamicToolUIPart, UIMessage } from "ai";
import type {
  ChatContextUsage,
  ChatDocument,
  ChatImage,
  ChatMessage,
  ChatMessagePart,
  ChatToolCall,
  ChatToolCallStatus,
} from "../../shared/types";

export interface DesktopUIMessageMetadata {
  createdAt?: number;
  contextUsage?: ChatContextUsage;
  requestId?: string;
}

export interface DesktopWarningData {
  requestId: string;
  message: string;
}

export interface DesktopToolResultData {
  toolCallId: string;
  status: Extract<ChatToolCallStatus, "completed" | "denied" | "error">;
  resultPresent: boolean;
  errorPresent: boolean;
  result?: string;
  error?: string;
}

export type DesktopUIDataTypes = {
  "image-attachment": ChatImage;
  "document-attachment": ChatDocument;
  "tool-result": DesktopToolResultData;
  warning: DesktopWarningData;
};

export type DesktopUIMessage = UIMessage<
  DesktopUIMessageMetadata,
  DesktopUIDataTypes
>;

export interface DesktopToolMetadata {
  displayName: string;
  requiresApproval: boolean;
  arguments: string;
  requestId?: string;
}

const TOOL_METADATA_KEYS = {
  displayName: "desktopDisplayName",
  requiresApproval: "desktopRequiresApproval",
  arguments: "desktopArguments",
  requestId: "desktopRequestId",
} as const;

export function createDesktopToolMetadata(
  metadata: DesktopToolMetadata,
): Record<string, string | boolean> {
  return {
    [TOOL_METADATA_KEYS.displayName]: metadata.displayName,
    [TOOL_METADATA_KEYS.requiresApproval]: metadata.requiresApproval,
    [TOOL_METADATA_KEYS.arguments]: metadata.arguments,
    ...(metadata.requestId
      ? { [TOOL_METADATA_KEYS.requestId]: metadata.requestId }
      : {}),
  };
}

export function readDesktopToolMetadata(
  part: Pick<DynamicToolUIPart, "toolMetadata" | "title" | "toolName" | "input">,
): DesktopToolMetadata {
  const metadata = part.toolMetadata;
  const displayName = metadata?.[TOOL_METADATA_KEYS.displayName];
  const requiresApproval = metadata?.[TOOL_METADATA_KEYS.requiresApproval];
  const argumentsValue = metadata?.[TOOL_METADATA_KEYS.arguments];
  const requestId = metadata?.[TOOL_METADATA_KEYS.requestId];
  return {
    displayName: typeof displayName === "string"
      ? displayName
      : part.title ?? part.toolName,
    requiresApproval: typeof requiresApproval === "boolean"
      ? requiresApproval
      : "approval" in part,
    arguments: typeof argumentsValue === "string"
      ? argumentsValue
      : stringifyToolInput(part.input),
    ...(typeof requestId === "string" ? { requestId } : {}),
  };
}

export function chatMessageToDesktopUIMessage(message: ChatMessage): DesktopUIMessage {
  const parts: DesktopUIMessage["parts"] = [];
  const orderedParts = message.parts?.length && orderedPartsMatchMessage(message)
    ? message.parts
    : undefined;

  if (orderedParts) {
    orderedParts.forEach((part, index) => {
      switch (part.type) {
        case "data-image-attachment":
          parts.push({
            type: part.type,
            id: `${message.id}:image:${index}`,
            data: part.data,
          });
          break;
        case "data-document-attachment":
          parts.push({
            type: part.type,
            id: `${message.id}:document:${index}`,
            data: part.data,
          });
          break;
        case "reasoning":
          parts.push({
            type: part.type,
            id: `${message.id}:reasoning:${index}`,
            text: part.text,
            state: "done",
          });
          break;
        case "dynamic-tool":
          parts.push(chatToolCallToDynamicPart(part.call));
          break;
        case "data-tool-result":
          parts.push({
            type: part.type,
            id: `${message.id}:tool-result:${index}`,
            data: part.data,
          });
          break;
        case "text":
          parts.push({ type: part.type, text: part.text, state: "done" });
          break;
      }
    });
  } else {
    appendLegacyOrderedParts(parts, message);
  }

  return {
    id: message.id,
    role: message.role,
    metadata: {
      createdAt: message.createdAt,
      ...(message.contextUsage ? { contextUsage: message.contextUsage } : {}),
    },
    parts,
  };
}

export function chatMessagesToDesktopUIMessages(
  messages: readonly ChatMessage[],
): DesktopUIMessage[] {
  return messages.map(chatMessageToDesktopUIMessage);
}

export function desktopUIMessageToChatMessage(
  message: DesktopUIMessage,
  fallbackCreatedAt = Date.now(),
): ChatMessage {
  if (message.role === "system") {
    throw new Error("System UI messages cannot be stored in desktop chat history.");
  }

  const text: string[] = [];
  const reasoning: string[] = [];
  const images: ChatImage[] = [];
  const documents: ChatDocument[] = [];
  const toolCalls: ChatToolCall[] = [];
  const toolResults = new Map<string, DesktopToolResultData>();
  const orderedParts: ChatMessagePart[] = [];

  for (const part of message.parts) {
    if (part.type === "data-tool-result") {
      toolResults.set(part.data.toolCallId, part.data);
    }
  }

  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        text.push(part.text);
        orderedParts.push({ type: part.type, text: part.text });
        break;
      case "reasoning":
        reasoning.push(part.text);
        orderedParts.push({ type: part.type, text: part.text });
        break;
      case "dynamic-tool": {
        const call = dynamicPartToChatToolCall(
          part,
          toolResults.get(part.toolCallId),
        );
        toolCalls.push(call);
        orderedParts.push({ type: part.type, call });
        break;
      }
      case "data-image-attachment":
        images.push(part.data);
        orderedParts.push({ type: part.type, data: part.data });
        break;
      case "data-document-attachment":
        documents.push(part.data);
        orderedParts.push({ type: part.type, data: part.data });
        break;
      case "data-tool-result":
        orderedParts.push({ type: part.type, data: part.data });
        break;
      default:
        break;
    }
  }

  return {
    id: message.id,
    role: message.role,
    content: text.join(""),
    ...(orderedParts.length ? { parts: orderedParts } : {}),
    ...(images.length ? { images } : {}),
    ...(documents.length ? { documents } : {}),
    ...(reasoning.length ? { reasoning: reasoning.join("") } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(message.metadata?.contextUsage
      ? { contextUsage: message.metadata.contextUsage }
      : {}),
    createdAt: message.metadata?.createdAt ?? fallbackCreatedAt,
  };
}

function appendLegacyOrderedParts(
  parts: DesktopUIMessage["parts"],
  message: ChatMessage,
): void {
  for (const [index, image] of (message.images ?? []).entries()) {
    parts.push({
      type: "data-image-attachment",
      id: `${message.id}:image:${index}`,
      data: image,
    });
  }
  for (const [index, document] of (message.documents ?? []).entries()) {
    parts.push({
      type: "data-document-attachment",
      id: `${message.id}:document:${index}`,
      data: document,
    });
  }
  if (message.reasoning !== undefined) {
    parts.push({
      type: "reasoning",
      id: `${message.id}:reasoning`,
      text: message.reasoning,
      state: "done",
    });
  }
  for (const call of message.toolCalls ?? []) {
    parts.push(chatToolCallToDynamicPart(call));
    if (isTerminalStatus(call.status)) {
      parts.push({
        type: "data-tool-result",
        id: call.id,
        data: toolResultDataFromCall(call),
      });
    }
  }
  if (message.content) {
    parts.push({ type: "text", text: message.content, state: "done" });
  }
}

function orderedPartsMatchMessage(message: ChatMessage): boolean {
  if (!message.parts) return false;
  const text: string[] = [];
  const reasoning: string[] = [];
  const images: ChatImage[] = [];
  const documents: ChatDocument[] = [];
  const toolCalls: ChatToolCall[] = [];

  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        text.push(part.text);
        break;
      case "reasoning":
        reasoning.push(part.text);
        break;
      case "data-image-attachment":
        images.push(part.data);
        break;
      case "data-document-attachment":
        documents.push(part.data);
        break;
      case "dynamic-tool":
        toolCalls.push(part.call);
        break;
      case "data-tool-result":
        break;
    }
  }

  return JSON.stringify({
    content: text.join(""),
    reasoning: reasoning.length ? reasoning.join("") : undefined,
    images: normalizeImages(images),
    documents: documents.length ? documents : undefined,
    toolCalls: toolCalls.length ? toolCalls : undefined,
  }) === JSON.stringify({
    content: message.content,
    reasoning: message.reasoning,
    images: normalizeImages(message.images ?? []),
    documents: message.documents?.length ? message.documents : undefined,
    toolCalls: message.toolCalls?.length ? message.toolCalls : undefined,
  });
}

function normalizeImages(images: ChatImage[]): Omit<ChatImage, "previewUrl">[] | undefined {
  return images.length
    ? images.map(({ path, name, mimeType }) => ({ path, name, mimeType }))
    : undefined;
}

function toolResultDataFromCall(call: ChatToolCall): DesktopToolResultData {
  if (!isTerminalStatus(call.status)) {
    throw new Error("Only terminal tool calls have persisted result data.");
  }
  return {
    toolCallId: call.id,
    status: call.status,
    resultPresent: call.result !== undefined,
    errorPresent: call.error !== undefined,
    ...(call.result !== undefined ? { result: call.result } : {}),
    ...(call.error !== undefined ? { error: call.error } : {}),
  };
}

export function desktopUIMessagesToChatMessages(
  messages: readonly DesktopUIMessage[],
  fallbackCreatedAt = Date.now(),
): ChatMessage[] {
  return messages.map((message) => desktopUIMessageToChatMessage(
    message,
    fallbackCreatedAt,
  ));
}

function chatToolCallToDynamicPart(call: ChatToolCall): DynamicToolUIPart {
  const input = parseToolInput(call.arguments);
  const base = {
    type: "dynamic-tool" as const,
    toolName: call.name,
    toolCallId: call.id,
    title: call.displayName,
    toolMetadata: createDesktopToolMetadata({
      displayName: call.displayName,
      requiresApproval: call.requiresApproval,
      arguments: call.arguments,
    }),
    input,
  };

  switch (call.status) {
    case "pending-approval":
      return {
        ...base,
        state: "approval-requested",
        approval: { id: call.id },
      };
    case "running":
      return { ...base, state: "input-available" };
    case "completed":
      return {
        ...base,
        state: "output-available",
        output: call.result ?? "",
        ...(call.requiresApproval
          ? { approval: { id: call.id, approved: true as const } }
          : {}),
      };
    case "denied":
      return {
        ...base,
        state: "output-denied",
        approval: { id: call.id, approved: false },
      };
    case "error":
      return {
        ...base,
        state: "output-error",
        errorText: call.error ?? "",
        ...(call.requiresApproval
          ? { approval: { id: call.id, approved: true as const } }
          : {}),
      };
  }
}

function dynamicPartToChatToolCall(
  part: DynamicToolUIPart,
  supplemental: DesktopToolResultData | undefined,
): ChatToolCall {
  const metadata = readDesktopToolMetadata(part);
  const status = statusFromDynamicPart(part);
  const result = supplemental
    ? supplemental.resultPresent ? supplemental.result : undefined
    : status === "completed" ? stringifyToolOutput(part.output) : undefined;
  const error = supplemental
    ? supplemental.errorPresent ? supplemental.error : undefined
    : status === "error" ? part.errorText : undefined;
  return {
    id: part.toolCallId,
    name: part.toolName,
    displayName: metadata.displayName,
    arguments: metadata.arguments,
    status,
    requiresApproval: metadata.requiresApproval,
    ...(result !== undefined ? { result } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

function statusFromDynamicPart(part: DynamicToolUIPart): ChatToolCallStatus {
  switch (part.state) {
    case "approval-requested":
      return "pending-approval";
    case "approval-responded":
      return part.approval.approved ? "running" : "denied";
    case "output-available":
      return "completed";
    case "output-denied":
      return "denied";
    case "output-error":
      return "error";
    case "input-streaming":
    case "input-available":
      return "running";
  }
}

function isTerminalStatus(
  status: ChatToolCallStatus,
): status is Extract<ChatToolCallStatus, "completed" | "denied" | "error"> {
  return status === "completed" || status === "denied" || status === "error";
}

function parseToolInput(value: string): unknown {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return { rawArguments: value };
  }
}

function stringifyToolInput(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2) ?? "{}";
  } catch {
    return "{}";
  }
}

function stringifyToolOutput(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value ?? "");
  }
}
