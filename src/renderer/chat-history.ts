import type { ChatMessage, ChatMessagePart } from "../shared/types";

export const CHAT_HISTORY_KEY = "desk-pet:history:v1";
export const LEGACY_CHAT_HISTORY_KEY = "minicpm5-desk-pet:history:v1";
export const CHAT_HISTORY_LIMIT = 40;

export interface ChatHistoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function withoutImagePreviews(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    ...(message.parts
      ? { parts: withoutPartImagePreviews(message.parts) }
      : {}),
    ...(message.images
      ? {
          images: message.images.map(({ path, name, mimeType }) => ({ path, name, mimeType })),
        }
      : {}),
  }));
}

function withoutPartImagePreviews(parts: ChatMessagePart[]): ChatMessagePart[] {
  return parts.map((part) => part.type === "data-image-attachment"
    ? {
        ...part,
        data: {
          path: part.data.path,
          name: part.data.name,
          mimeType: part.data.mimeType,
        },
      }
    : part);
}

export function readChatHistory(storage: ChatHistoryStorage = localStorage): ChatMessage[] {
  try {
    const saved = storage.getItem(CHAT_HISTORY_KEY) ?? storage.getItem(LEGACY_CHAT_HISTORY_KEY);
    const parsed = JSON.parse(saved ?? "[]") as ChatMessage[];
    return Array.isArray(parsed) ? parsed.slice(-CHAT_HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

export function writeChatHistory(
  messages: ChatMessage[],
  storage: ChatHistoryStorage = localStorage,
): ChatMessage[] {
  const trimmed = withoutImagePreviews(messages.slice(-CHAT_HISTORY_LIMIT));
  try {
    storage.setItem(CHAT_HISTORY_KEY, JSON.stringify(trimmed));
  } catch {
    // Chat remains usable even when storage is unavailable or full.
  }
  return trimmed;
}

export function appendChatMessages(
  messages: ChatMessage[],
  storage: ChatHistoryStorage = localStorage,
): ChatMessage[] {
  return writeChatHistory([...readChatHistory(storage), ...messages], storage);
}

export function updateChatMessage(
  messageId: string,
  update: (message: ChatMessage) => ChatMessage,
  storage: ChatHistoryStorage = localStorage,
): ChatMessage[] {
  const history = readChatHistory(storage);
  return writeChatHistory(
    history.map((message) => (message.id === messageId ? update(message) : message)),
    storage,
  );
}

export function clearLegacyChatHistory(storage: ChatHistoryStorage = localStorage): void {
  storage.removeItem(CHAT_HISTORY_KEY);
  storage.removeItem(LEGACY_CHAT_HISTORY_KEY);
}
