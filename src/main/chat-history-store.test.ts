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
      message("message-1", "user", "  帮我继续完善桌面宠物的聊天历史  ", {
        documents: [{
          path: "D:\\requirements.pdf",
          name: "requirements.pdf",
          mimeType: "application/pdf",
          text: "附件需求正文",
          characterCount: 6,
        }],
      }),
      message("message-2", "assistant", "没问题", {
        reasoning: "内部思考",
        images: [{
          path: "D:\\cat.png",
          name: "cat.png",
          mimeType: "image/png",
          previewUrl: "data:image/png;base64,large",
        }],
        toolCalls: [{
          id: "tool-1",
          name: "read_file",
          displayName: "读取文件",
          arguments: "{\"path\":\"README.md\"}",
          status: "completed",
          requiresApproval: false,
          result: "文件内容",
        }],
      }),
    ]);

    expect(store.listConversations()[0]).toMatchObject({
      title: "帮我继续完善桌面宠物的聊天历史",
      messageCount: 2,
    });
    expect(store.loadMessages(conversation.id)).toEqual([
      message("message-1", "user", "  帮我继续完善桌面宠物的聊天历史  ", {
        documents: [{
          path: "D:\\requirements.pdf",
          name: "requirements.pdf",
          mimeType: "application/pdf",
          text: "附件需求正文",
          characterCount: 6,
        }],
      }),
      message("message-2", "assistant", "没问题", {
        reasoning: "内部思考",
        images: [{ path: "D:\\cat.png", name: "cat.png", mimeType: "image/png" }],
        toolCalls: [{
          id: "tool-1",
          name: "read_file",
          displayName: "读取文件",
          arguments: "{\"path\":\"README.md\"}",
          status: "completed",
          requiresApproval: false,
          result: "文件内容",
        }],
      }),
    ]);

    store.deleteConversation(conversation.id);
    expect(store.listConversations()).toEqual([]);
    expect(() => store.loadMessages(conversation.id)).toThrow("找不到指定的聊天会话");
  });

  it("deletes multiple conversations in one operation", () => {
    const store = createStore();
    const first = store.createConversation();
    const second = store.createConversation();
    const keep = store.createConversation();

    store.deleteConversations([first.id, second.id, first.id]);

    expect(store.listConversations().map((conversation) => conversation.id)).toEqual([keep.id]);
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

});
