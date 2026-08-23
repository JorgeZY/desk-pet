import { describe, expect, it, vi } from "vitest";
import { positionToPreserveForModeChange, toggleShortcutWindow } from "./window-shortcut";

describe("positionToPreserveForModeChange", () => {
  const draggedBounds = { x: 740, y: 360 };

  it("uses the current chat position when returning to the pet", () => {
    expect(positionToPreserveForModeChange("chat", "pet", draggedBounds)).toEqual(draggedBounds);
  });

  it("preserves the current position when leaving the pet too", () => {
    expect(positionToPreserveForModeChange("pet", "settings", draggedBounds)).toEqual(draggedBounds);
  });

  it("does not overwrite the pet position between non-pet modes", () => {
    expect(positionToPreserveForModeChange("chat", "settings", draggedBounds)).toBeNull();
  });
});

describe("toggleShortcutWindow", () => {
  it("hides an already visible window without changing its view", () => {
    const hide = vi.fn();
    const restorePetWindow = vi.fn();

    toggleShortcutWindow({ isVisible: () => true, hide }, restorePetWindow);

    expect(hide).toHaveBeenCalledOnce();
    expect(restorePetWindow).not.toHaveBeenCalled();
  });

  it("restores a hidden window through the pet-mode path", () => {
    const hide = vi.fn();
    const restorePetWindow = vi.fn();

    toggleShortcutWindow({ isVisible: () => false, hide }, restorePetWindow);

    expect(hide).not.toHaveBeenCalled();
    expect(restorePetWindow).toHaveBeenCalledOnce();
  });

  it("restores pet mode even when the window has not been created yet", () => {
    const restorePetWindow = vi.fn();

    toggleShortcutWindow(null, restorePetWindow);

    expect(restorePetWindow).toHaveBeenCalledOnce();
  });
});
