import { describe, expect, it } from "vitest";
import {
  captionCharactersPerLine,
  captionMaximumLines,
  formatCaptionLines,
  selectCaptionDisplayText,
  StableCaptionPresenter,
} from "./caption-display";
import type { CaptionState } from "../shared/types";

describe("live caption display", () => {
  const segments = [
    { id: "old", text: "较早的字幕", startMs: 0, endMs: 1000 },
    { id: "latest", text: "最新稳定字幕", startMs: 1000, endMs: 2000 },
  ];

  it("shows only the latest stable segment instead of stacking history", () => {
    expect(selectCaptionDisplayText({ partial: "", segments })).toEqual({
      text: "最新稳定字幕",
      live: false,
    });
  });

  it("replaces the stable segment with the current partial", () => {
    expect(selectCaptionDisplayText({ partial: " updating live caption ", segments })).toEqual({
      text: "updating live caption",
      live: true,
    });
  });

  it("replaces each live update instead of appending it to the previous line", () => {
    expect(selectCaptionDisplayText({ partial: "first live result", segments }).text).toBe("first live result");
    expect(selectCaptionDisplayText({ partial: "second live result", segments }).text).toBe("second live result");
    expect(selectCaptionDisplayText({ partial: "", segments })).toEqual({
      text: "最新稳定字幕",
      live: false,
    });
  });

  it("returns an empty display for a new session", () => {
    expect(selectCaptionDisplayText(null)).toEqual({ text: "", live: false });
    expect(formatCaptionLines("   ", 22)).toEqual([]);
  });

  it("limits every supported font size to one or two bounded lines", () => {
    const text = Array.from({ length: 40 }, (_, index) => "caption" + index).join(" ");
    for (let fontSize = 16; fontSize <= 36; fontSize += 2) {
      const lines = formatCaptionLines(text, fontSize);
      expect(lines.length).toBeLessThanOrEqual(captionMaximumLines(fontSize));
      expect(lines.every((line) => Array.from(line).length <= captionCharactersPerLine(fontSize))).toBe(true);
      expect(lines.at(-1)).toContain("caption39");
    }
  });

  it("uses one row for large type so glyphs cannot be clipped by the fixed window", () => {
    expect(captionMaximumLines(24)).toBe(2);
    expect(captionMaximumLines(26)).toBe(1);
    expect(captionMaximumLines(36)).toBe(1);
  });

  it("splits an overlong token and keeps only its latest visible chunks", () => {
    const limit = captionCharactersPerLine(22);
    const lines = formatCaptionLines("x".repeat(limit * 3), 22);
    expect(lines).toEqual(["x".repeat(limit), "x".repeat(limit)]);
  });

  it("promotes a completed visual line without appending caption history", () => {
    const presenter = new StableCaptionPresenter();
    const limit = captionCharactersPerLine(22);
    const first = "a".repeat(limit);
    const second = "b".repeat(limit);
    const state = (partial: string): CaptionState => ({
      sessionId: String(1),
      phase: "capturing",
      message: String(),
      modelDirectory: String(),
      updatedAt: 0,
      partial,
      segments: [],
    });

    presenter.update(state(first + " live"), 22);
    expect(presenter.update(state(first + " live grows"), 22).lines).toEqual([first, "live grows"]);
    expect(presenter.update(state(first + " " + second + " current"), 22).lines).toEqual([first, "current"]);
    expect(presenter.update(state(first + " " + second + " current grows"), 22).lines).toEqual([
      second,
      "current grows",
    ]);
  });

  it("shows an endpoint result immediately and resets visual line stability", () => {
    const presenter = new StableCaptionPresenter();
    const state: CaptionState = {
      sessionId: String(1),
      phase: "capturing",
      message: String(),
      modelDirectory: String(),
      updatedAt: 0,
      partial: "",
      segments: [{ id: "final", text: "final endpoint text", startMs: 0, endMs: 1000 }],
    };

    expect(presenter.update(state, 22)).toEqual({ lines: ["final endpoint text"], live: false });
  });
});
