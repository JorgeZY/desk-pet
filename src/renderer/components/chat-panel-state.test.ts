import { describe, expect, it } from "vitest";
import {
  conversationOperationUiPolicy,
  isCurrentConversationOperation,
  shouldResetComposer,
} from "./chat-panel-state";

describe("chat panel conversation operation guards", () => {
  it("only commits the latest operation", () => {
    expect(isCurrentConversationOperation(2, 2)).toBe(true);
    expect(isCurrentConversationOperation(1, 2)).toBe(false);
  });

  it("only resets a composer that the user has not changed while waiting", () => {
    expect(shouldResetComposer(4, 4)).toBe(true);
    expect(shouldResetComposer(4, 5)).toBe(false);
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
