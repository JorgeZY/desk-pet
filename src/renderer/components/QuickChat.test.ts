import { describe, expect, it, vi } from "vitest";
import { PET_WINDOW_BASE_HEIGHT } from "../../shared/pet-window";
import { resetQuickChatWindowHeight } from "./QuickChat";

describe("resetQuickChatWindowHeight", () => {
  it("restores the compact height when Quick Chat unmounts", () => {
    const setPetWindowHeight = vi.fn(async () => undefined);

    resetQuickChatWindowHeight(setPetWindowHeight);

    expect(setPetWindowHeight).toHaveBeenCalledOnce();
    expect(setPetWindowHeight).toHaveBeenCalledWith(PET_WINDOW_BASE_HEIGHT);
  });
});
