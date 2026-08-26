import { describe, expect, it } from "vitest";
import { clampWorkbenchBounds, normalizeWindowUiState } from "./window-state";

describe("normalizeWindowUiState", () => {
  it("uses safe defaults for missing or partial state", () => {
    expect(normalizeWindowUiState({ sidebarCollapsed: true, petPosition: { x: 12 } })).toEqual({
      layoutVersion: 1,
      workbenchMaximized: false,
      sidebarCollapsed: true,
      petPosition: undefined,
      workbenchBounds: undefined,
    });
  });
});

describe("clampWorkbenchBounds", () => {
  it("enforces the minimum size and keeps the window visible", () => {
    expect(clampWorkbenchBounds(
      { x: 1800, y: 1000, width: 400, height: 300 },
      { x: 0, y: 0, width: 1920, height: 1080 },
    )).toEqual({ x: 1020, y: 460, width: 900, height: 620 });
  });

  it("fits the bounds to a smaller work area", () => {
    expect(clampWorkbenchBounds(
      { x: -2000, y: -100, width: 1600, height: 1200 },
      { x: -1280, y: 0, width: 1280, height: 720 },
    )).toEqual({ x: -1280, y: 0, width: 1280, height: 720 });
  });
});
