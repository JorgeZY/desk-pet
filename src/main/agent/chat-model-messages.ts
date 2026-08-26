import { promises as fs } from "node:fs";
import type { ModelMessage, UserModelMessage } from "ai";
import type {
  ChatImageMimeType,
  ChatMessage,
  ChatToolCall,
} from "../../shared/types";

const MAX_CHAT_REQUEST_IMAGES = 4;
const MAX_CHAT_REQUEST_IMAGE_BYTES = 10 * 1024 * 1024;
const SUPPORTED_IMAGE_MIME_TYPES = new Set<ChatImageMimeType>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

type ImageReader = (path: string) => Promise<Uint8Array>;
type ImageSizer = (path: string) => Promise<number>;

export interface BuildAgentModelMessagesOptions {
  visionEnabled?: boolean;
  readImage?: ImageReader;
  getImageSize?: ImageSizer;
  onWarning?: (message: string) => void;
}

/**
 * Converts persisted chat messages directly into AI SDK model messages.
 * The ToolLoopAgent owns the system prompt. Document parts intentionally stay
 * separate from the user's typed text so the exact context budgeter can trim
 * attachments without modifying the user's request.
 */
export async function buildAgentModelMessages(
  messages: readonly ChatMessage[],
  options: BuildAgentModelMessagesOptions = {},
): Promise<ModelMessage[]> {
  const warnings = new Set<string>();
  const warn = (message: string): void => {
    if (warnings.has(message)) return;
    warnings.add(message);
    options.onWarning?.(message);
  };
  const imageParts = options.visionEnabled
    ? await loadRecentImageParts(messages, options, warn)
    : new Map<string, UserModelMessage["content"]>();
  const result: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      result.push(buildUserMessage(message, imageParts.get(message.id)));
      continue;
    }

    for (const call of message.toolCalls ?? []) {
      if (!isTerminalToolCall(call)) continue;
      result.push({
        role: "assistant",
        content: [{
          type: "tool-call",
          toolCallId: call.id,
          toolName: call.name,
          input: parseToolInput(call.arguments),
        }],
      });
      result.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: call.id,
          toolName: call.name,
          output: {
            type: "text",
            value: call.result ?? call.error ?? "工具没有返回内容。",
          },
        }],
      });
    }
    if (message.content || !message.toolCalls?.length) {
      result.push({ role: "assistant", content: message.content });
    }
  }

  return result;
}

function buildUserMessage(
  message: ChatMessage,
  loadedImages?: UserModelMessage["content"],
): UserModelMessage {
  const documents = message.documents ?? [];
  const images = Array.isArray(loadedImages) ? loadedImages : [];
  if (!documents.length && !images.length) {
    return { role: "user", content: message.content };
  }

  const content: Exclude<UserModelMessage["content"], string> = [
    { type: "text", text: message.content },
  ];
  for (const document of documents) {
    const truncation = document.truncated
      ? `（原文 ${document.characterCount} 字符，当前请求仅包含前 ${document.text.length} 字符）`
      : "";
    content.push({
      type: "text",
      text: `<document name="${document.name}">${truncation}\n${document.text}\n</document>`,
    });
  }
  content.push(...images);
  return { role: "user", content };
}

async function loadRecentImageParts(
  messages: readonly ChatMessage[],
  options: BuildAgentModelMessagesOptions,
  warn: (message: string) => void,
): Promise<Map<string, UserModelMessage["content"]>> {
  const readImage = options.readImage ?? fs.readFile;
  const getImageSize = options.getImageSize ?? (async (path: string) => (await fs.stat(path)).size);
  const parts = new Map<string, Exclude<UserModelMessage["content"], string>>();
  let requestImageCount = 0;
  let requestImageBytes = 0;

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (message.role !== "user" || !message.images?.length) continue;
    const messageParts: Exclude<UserModelMessage["content"], string> = [];

    for (const image of message.images) {
      if (requestImageCount >= MAX_CHAT_REQUEST_IMAGES) {
        warn("为保护内存，本次请求仅发送最近 4 张图片，较早图片已跳过。");
        break;
      }
      if (!SUPPORTED_IMAGE_MIME_TYPES.has(image.mimeType)) {
        warn(`图片 ${image.name} 的格式不受支持，已跳过。`);
        continue;
      }

      let declaredBytes: number;
      try {
        declaredBytes = await getImageSize(image.path);
      } catch {
        warn(`历史图片 ${image.name} 已不可用，已跳过。`);
        continue;
      }
      if (declaredBytes > MAX_CHAT_REQUEST_IMAGE_BYTES) {
        warn(`图片 ${image.name} 超过 10 MB，已跳过。`);
        continue;
      }
      if (requestImageBytes + declaredBytes > MAX_CHAT_REQUEST_IMAGE_BYTES) {
        warn("为保护内存，本次请求图片合计不超过 10 MB，较早图片已跳过。");
        continue;
      }

      let bytes: Uint8Array;
      try {
        bytes = await readImage(image.path);
      } catch {
        warn(`历史图片 ${image.name} 已不可用，已跳过。`);
        continue;
      }
      const effectiveBytes = Math.max(declaredBytes, bytes.byteLength);
      if (effectiveBytes > MAX_CHAT_REQUEST_IMAGE_BYTES) {
        warn(`图片 ${image.name} 超过 10 MB，已跳过。`);
        continue;
      }
      if (requestImageBytes + effectiveBytes > MAX_CHAT_REQUEST_IMAGE_BYTES) {
        warn("为保护内存，本次请求图片合计不超过 10 MB，较早图片已跳过。");
        continue;
      }

      const url = `data:${image.mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
      messageParts.push({ type: "image", image: new URL(url), mediaType: image.mimeType });
      requestImageCount += 1;
      requestImageBytes += effectiveBytes;
    }

    if (messageParts.length) parts.set(message.id, messageParts);
  }
  return parts;
}

function isTerminalToolCall(call: ChatToolCall): boolean {
  return call.status === "completed" || call.status === "denied" || call.status === "error";
}

function parseToolInput(value: string): unknown {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return { rawArguments: value };
  }
}
