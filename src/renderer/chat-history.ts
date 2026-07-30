import type { ChatMessage } from "../shared/types";

export const CHAT_HISTORY_KEY = "desk-pet:history:v1";
export const LEGACY_CHAT_HISTORY_KEY = "minicpm5-desk-pet:history:v1";
export const CHAT_HISTORY_LIMIT = 40;

export interface ChatHistoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
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
  const trimmed = messages.slice(-CHAT_HISTORY_LIMIT);
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
