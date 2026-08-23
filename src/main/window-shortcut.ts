import type { WindowMode } from "../shared/types";

interface ShortcutWindow {
  isVisible(): boolean;
  hide(): void;
}

export function positionToPreserveForModeChange(
  previousMode: WindowMode,
  nextMode: WindowMode,
  bounds: { x: number; y: number },
): { x: number; y: number } | null {
  const crossesPetBoundary = (previousMode === "pet") !== (nextMode === "pet");
  return crossesPetBoundary ? { x: bounds.x, y: bounds.y } : null;
}

export function toggleShortcutWindow(
  window: ShortcutWindow | null | undefined,
  restorePetWindow: () => void,
): void {
  if (window?.isVisible()) {
    window.hide();
    return;
  }
  restorePetWindow();
}
