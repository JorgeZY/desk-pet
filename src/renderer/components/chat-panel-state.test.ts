import { describe, expect, it } from "vitest";
import {
  conversationOperationUiPolicy,
  continuationRequestMessages,
  isNearChatBottom,
  isCurrentConversationOperation,
  regenerationBaseMessages,
  shouldResetComposer,
  shouldResetComposerAfterInitialization,
} from "./chat-panel-state";

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
