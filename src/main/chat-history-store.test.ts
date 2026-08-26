import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "../shared/types";
import { ChatHistoryStore } from "./chat-history-store";

const stores: ChatHistoryStore[] = [];
const tempDirectories: string[] = [];

afterEach(() => {
  while (stores.length) stores.pop()?.close();
  while (tempDirectories.length) {
    rmSync(tempDirectories.pop()!, { force: true, recursive: true });
  }
});

function createStore(filePath = ":memory:"): ChatHistoryStore {
  let timestamp = 1000;
  let id = 0;
  const store = new ChatHistoryStore(filePath, {
    now: () => timestamp++,
    createId: () => `conversation-${id++}`,
  });
  stores.push(store);
  return store;
}

function closeStore(store: ChatHistoryStore): void {
  store.close();
  stores.splice(stores.indexOf(store), 1);
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
        contextUsage: { promptTokens: 640, completionTokens: 128, totalTokens: 768 },
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
        contextUsage: { promptTokens: 640, completionTokens: 128, totalTokens: 768 },
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

  it("restores ordered message parts after reopening without requiring context usage", () => {
    const directory = mkdtempSync(join(tmpdir(), "desk-pet-chat-history-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "history.sqlite");
    const store = createStore(databasePath);
    const conversation = store.createConversation();
    const call = {
      id: "tool-ordered",
      name: "read_file",
      displayName: "读取文件",
      arguments: "{\"path\":\"README.md\"}",
      status: "completed" as const,
      requiresApproval: false,
      result: "文件内容",
    };
    store.saveMessages(conversation.id, [message(
      "message-ordered",
      "assistant",
      "调用前调用后",
      {
        reasoning: "检查结果",
        images: [{
          path: "D:\\cat.png",
          name: "cat.png",
          mimeType: "image/png",
          previewUrl: "data:image/png;base64,large",
        }],
        documents: [{
          path: "D:\\notes.txt",
          name: "notes.txt",
          mimeType: "text/plain",
          text: "notes",
          characterCount: 5,
        }],
        toolCalls: [call],
        parts: [
          { type: "text", text: "调用前" },
          { type: "dynamic-tool", call },
          {
            type: "data-tool-result",
            data: {
              toolCallId: call.id,
              status: "completed",
              resultPresent: true,
              errorPresent: false,
              result: "文件内容",
            },
          },
          { type: "reasoning", text: "检查结果" },
          {
            type: "data-image-attachment",
            data: {
              path: "D:\\cat.png",
              name: "cat.png",
              mimeType: "image/png",
              previewUrl: "data:image/png;base64,large",
            },
          },
          {
            type: "data-document-attachment",
            data: {
              path: "D:\\notes.txt",
              name: "notes.txt",
              mimeType: "text/plain",
              text: "notes",
              characterCount: 5,
            },
          },
          { type: "text", text: "调用后" },
        ],
      },
    )]);
    closeStore(store);

    const reopened = createStore(databasePath);
    const restored = reopened.loadMessages(conversation.id)[0];

    expect(restored?.contextUsage).toBeUndefined();
    expect(restored?.parts?.map((part) => part.type)).toEqual([
      "text",
      "dynamic-tool",
      "data-tool-result",
      "reasoning",
      "data-image-attachment",
      "data-document-attachment",
      "text",
    ]);
    expect(restored?.images?.[0]).not.toHaveProperty("previewUrl");
    expect(restored?.parts?.find((part) => part.type === "data-image-attachment"))
      .not.toHaveProperty("data.previewUrl");
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
