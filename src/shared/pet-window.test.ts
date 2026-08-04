import { describe, expect, it } from "vitest";
import {
  PET_WINDOW_BASE_HEIGHT,
  PET_WINDOW_MAX_HEIGHT,
  quickReplyWindowHeight,
} from "./pet-window";

describe("quickReplyWindowHeight", () => {
  it("keeps the compact pet height when there is no assistant reply", () => {
    expect(quickReplyWindowHeight(240, false)).toBe(PET_WINDOW_BASE_HEIGHT);
  });

  it("grows in stable steps instead of resizing for every streamed token", () => {
    expect(quickReplyWindowHeight(35, true)).toBe(438);
    expect(quickReplyWindowHeight(79, true)).toBe(438);
    expect(quickReplyWindowHeight(83, true)).toBe(486);
  });

  it("caps very long replies at the largest pet window", () => {
    expect(quickReplyWindowHeight(2_000, true)).toBe(PET_WINDOW_MAX_HEIGHT);
  });
});
