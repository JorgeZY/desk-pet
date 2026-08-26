import { describe, expect, it, vi } from "vitest";
import {
  cancelActiveGenerationForUnmount,
  conversationOperationUiPolicy,
  continuationRequestMessages,
  isNearChatBottom,
  isCurrentConversationOperation,
  regenerationBaseMessages,
  shouldResetComposer,
  shouldResetComposerAfterInitialization,
  terminalizeAssistantGeneration,
} from "./chat-panel-state";

describe("chat panel generation cleanup", () => {
  it("aborts an unmounted request and persists a terminal tool state", () => {
    const abortChat = vi.fn();
    const messages = cancelActiveGenerationForUnmount(
      "request-1",
      "assistant-1",
      [{
        id: "assistant-1",
        role: "assistant",
        content: "",
        createdAt: 1,
        toolCalls: [{
          id: "tool-1",
          name: "mcp__files__write",
          displayName: "files · write",
          arguments: "{}",
          status: "pending-approval",
          requiresApproval: true,
        }],
      }],
      abortChat,
    );

    expect(abortChat).toHaveBeenCalledWith("request-1");
    expect(messages[0]).toMatchObject({
      content: "（团子停下了）",
      toolCalls: [{
        status: "error",
        error: "任务因聊天界面关闭而取消。",
      }],
    });
  });

  it("terminalizes pending and running tools when the user stops generation", () => {
    const messages = terminalizeAssistantGeneration(
      "assistant-1",
      [{
        id: "assistant-1",
        role: "assistant",
        content: "partial answer",
        createdAt: 1,
        toolCalls: [
          {
            id: "pending",
            name: "write_file",
            displayName: "write_file",
            arguments: "{}",
            status: "pending-approval",
            requiresApproval: true,
          },
          {
            id: "running",
            name: "read_file",
            displayName: "read_file",
            arguments: "{}",
            status: "running",
            requiresApproval: false,
          },
          {
            id: "completed",
            name: "list_files",
            displayName: "list_files",
            arguments: "{}",
            status: "completed",
            requiresApproval: false,
            result: "done",
          },
        ],
      }],
      "（团子停下了）",
      "任务已由用户停止。",
    );

    expect(messages[0].content).toBe("partial answer");
    expect(messages[0].toolCalls).toMatchObject([
      { id: "pending", status: "error", error: "任务已由用户停止。" },
      { id: "running", status: "error", error: "任务已由用户停止。" },
      { id: "completed", status: "completed", result: "done" },
    ]);
  });
});

describe("chat stream scrolling", () => {
  it("keeps following only while the reader remains near the bottom", () => {
    expect(isNearChatBottom(1000, 464, 500)).toBe(true);
    expect(isNearChatBottom(1000, 400, 500)).toBe(false);
  });
});

describe("chat regeneration", () => {
  const user = { id: "u", role: "user", content: "你好", createdAt: 1 } as const;
  const assistant = { id: "a", role: "assistant", content: "你好呀", createdAt: 2 } as const;

  it("removes the latest assistant answer and keeps its user prompt", () => {
    expect(regenerationBaseMessages([user, assistant])).toEqual([user]);
  });

  it("does not regenerate an unfinished user-only history", () => {
    expect(regenerationBaseMessages([user])).toBeNull();
  });
});

describe("chat continuation", () => {
  const user = { id: "u", role: "user", content: "解释一下", createdAt: 1 } as const;
  const assistant = { id: "a", role: "assistant", content: "第一部分", createdAt: 2 } as const;

  it("adds a request-only continuation instruction after the current answer", () => {
    expect(continuationRequestMessages([user, assistant], "continue", 3)).toEqual([
      user,
      assistant,
      {
        id: "continue",
        role: "user",
        content: "请直接从上一条回答结束的位置继续，不要重复已有内容。",
        createdAt: 3,
      },
    ]);
  });

  it("does not continue an empty or user-only history", () => {
    expect(continuationRequestMessages([user], "continue", 3)).toBeNull();
  });
});

describe("chat panel conversation operation guards", () => {
  it("only commits the latest operation", () => {
    expect(isCurrentConversationOperation(2, 2)).toBe(true);
    expect(isCurrentConversationOperation(1, 2)).toBe(false);
  });

  it("only resets a composer that the user has not changed while waiting", () => {
    expect(shouldResetComposer(4, 4)).toBe(true);
    expect(shouldResetComposer(4, 5)).toBe(false);
  });

  it("preserves a composer that already contained a draft during initialization", () => {
    expect(shouldResetComposerAfterInitialization(false, 4, 4)).toBe(false);
    expect(shouldResetComposerAfterInitialization(true, 4, 4)).toBe(true);
    expect(shouldResetComposerAfterInitialization(true, 4, 5)).toBe(false);
  });

  it("keeps the history drawer open after deleting a conversation", () => {
    expect(conversationOperationUiPolicy("delete", "start")).toEqual({
      closeHistory: false,
      focusComposer: false,
    });
    expect(conversationOperationUiPolicy("delete", "commit")).toEqual({
      closeHistory: false,
      focusComposer: false,
    });
  });

  it.each(["create", "switch"] as const)(
    "%s keeps history visible until its data is ready",
    (kind) => {
      expect(conversationOperationUiPolicy(kind, "start")).toEqual({
        closeHistory: false,
        focusComposer: false,
      });
      expect(conversationOperationUiPolicy(kind, "commit")).toEqual({
        closeHistory: true,
        focusComposer: true,
      });
    },
  );
});
