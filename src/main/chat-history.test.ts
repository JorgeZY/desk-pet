import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../shared/types";
import {
  appendChatMessages,
  CHAT_HISTORY_KEY,
  LEGACY_CHAT_HISTORY_KEY,
  readChatHistory,
  updateChatMessage,
  type ChatHistoryStorage,
} from "../renderer/chat-history";

class MemoryStorage implements ChatHistoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function message(index: number, role: ChatMessage["role"] = "user"): ChatMessage {
  return {
    id: `message-${index}`,
    role,
    content: `content-${index}`,
    createdAt: index,
  };
}

describe("chat history", () => {
  it("reads the legacy history when the current key is absent", () => {
    const storage = new MemoryStorage();
    storage.setItem(LEGACY_CHAT_HISTORY_KEY, JSON.stringify([message(1)]));

    expect(readChatHistory(storage)).toEqual([message(1)]);
  });

  it("appends chat turns and keeps the newest 40 messages", () => {
    const storage = new MemoryStorage();
    appendChatMessages(Array.from({ length: 39 }, (_, index) => message(index)), storage);

    const result = appendChatMessages([message(39), message(40, "assistant")], storage);

    expect(result).toHaveLength(40);
    expect(result[0]?.id).toBe("message-1");
    expect(result.at(-1)?.id).toBe("message-40");
    expect(JSON.parse(storage.getItem(CHAT_HISTORY_KEY) ?? "[]")).toEqual(result);
  });

  it("updates the persisted assistant reply and reasoning", () => {
    const storage = new MemoryStorage();
    appendChatMessages([message(1), { ...message(2, "assistant"), content: "" }], storage);

    updateChatMessage(
      "message-2",
      (current) => ({ ...current, content: "回答", reasoning: "思考" }),
      storage,
    );

    expect(readChatHistory(storage).at(-1)).toMatchObject({
      id: "message-2",
      role: "assistant",
      content: "回答",
      reasoning: "思考",
    });
  });

  it("persists image paths without large preview data", () => {
    const storage = new MemoryStorage();
    appendChatMessages([{
      ...message(1),
      images: [{
        path: "D:\\images\\cat.png",
        name: "cat.png",
        mimeType: "image/png",
        previewUrl: "data:image/png;base64,large-preview",
      }],
    }], storage);

    expect(readChatHistory(storage)[0]?.images).toEqual([{
      path: "D:\\images\\cat.png",
      name: "cat.png",
      mimeType: "image/png",
    }]);
    expect(storage.getItem(CHAT_HISTORY_KEY)).not.toContain("large-preview");
  });
});
