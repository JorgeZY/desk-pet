import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "../shared/types";
import { ChatHistoryStore } from "./chat-history-store";

const stores: ChatHistoryStore[] = [];

afterEach(() => {
  while (stores.length) stores.pop()?.close();
});

function createStore(): ChatHistoryStore {
  let timestamp = 1000;
  let id = 0;
  const store = new ChatHistoryStore(":memory:", {
    now: () => timestamp++,
    createId: () => `conversation-${id++}`,
  });
  stores.push(store);
  return store;
}

function message(
  id: string,
  role: ChatMessage["role"],
  content: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return { id, role, content, createdAt: Number(id.replace(/\D/g, "")) || 1, ...extra };
}

describe("ChatHistoryStore", () => {
  it("creates, titles, loads, and deletes conversations", () => {
    const store = createStore();
    const conversation = store.createConversation();
    store.saveMessages(conversation.id, [
      message("message-1", "user", "  帮我继续完善桌面宠物的聊天历史  "),
      message("message-2", "assistant", "没问题", {
        reasoning: "内部思考",
        images: [{
          path: "D:\\cat.png",
          name: "cat.png",
          mimeType: "image/png",
          previewUrl: "data:image/png;base64,large",
        }],
      }),
    ]);

    expect(store.listConversations()[0]).toMatchObject({
      title: "帮我继续完善桌面宠物的聊天历史",
      messageCount: 2,
    });
    expect(store.loadMessages(conversation.id)).toEqual([
      message("message-1", "user", "  帮我继续完善桌面宠物的聊天历史  "),
      message("message-2", "assistant", "没问题", {
        reasoning: "内部思考",
        images: [{ path: "D:\\cat.png", name: "cat.png", mimeType: "image/png" }],
      }),
    ]);

    store.deleteConversation(conversation.id);
    expect(store.listConversations()).toEqual([]);
    expect(() => store.loadMessages(conversation.id)).toThrow("找不到指定的聊天会话");
  });

  it("rolls back the whole message replacement when one row is invalid", () => {
    const store = createStore();
    const conversation = store.createConversation();
    const original = [message("message-1", "user", "原始内容")];
    store.saveMessages(conversation.id, original);

    expect(() => store.saveMessages(conversation.id, [
      message("duplicate", "user", "第一条"),
      message("duplicate", "assistant", "第二条"),
    ])).toThrow();
    expect(store.loadMessages(conversation.id)).toEqual(original);
    expect(store.listConversations()[0]?.title).toBe("原始内容");
  });

  it("retains only the 30 newest conversations", () => {
    const store = createStore();
    for (let index = 0; index < 31; index += 1) store.createConversation();

    const conversations = store.listConversations();
    expect(conversations).toHaveLength(30);
    expect(conversations.some((conversation) => conversation.id === "conversation-0")).toBe(false);
    expect(conversations[0]?.id).toBe("conversation-30");
  });

  it("builds a bounded recommendation context and caches its result", () => {
    const store = createStore();
    for (let conversationIndex = 0; conversationIndex < 6; conversationIndex += 1) {
      const conversation = store.createConversation();
      store.saveMessages(conversation.id, Array.from({ length: 8 }, (_, messageIndex) =>
        message(
          `m-${conversationIndex}-${messageIndex}`,
          messageIndex % 2 ? "assistant" : "user",
          `会话${conversationIndex}消息${messageIndex}`,
          { reasoning: "不应进入推荐上下文" },
        )));
    }

    const context = store.getRecommendationContext();
    expect(context).not.toBeNull();
    expect(context?.transcript.length).toBeLessThanOrEqual(1600);
    expect(context?.transcript).not.toContain("会话0消息");
    expect(context?.transcript).not.toContain("消息0");
    expect(context?.transcript).not.toContain("不应进入推荐上下文");
    expect(store.getCachedRecommendations(context!.fingerprint)).toBeNull();

    const recommendations = ["继续完善桌面宠物", "回顾最近的技术问题", "聊聊下一步计划"];
    store.cacheRecommendations(context!.fingerprint, recommendations);
    expect(store.getCachedRecommendations(context!.fingerprint)).toEqual(recommendations);
  });
});
