import type { WindowBounds, WindowUiState } from "./types";

export const WORKBENCH_DEFAULT_SIZE = { width: 1120, height: 760 } as const;
export const WORKBENCH_MIN_SIZE = { width: 900, height: 620 } as const;

export const DEFAULT_WINDOW_UI_STATE: WindowUiState = {
  layoutVersion: 1,
  workbenchMaximized: false,
  sidebarCollapsed: false,
};

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export function normalizeWindowUiState(value: unknown): WindowUiState {
  const raw = value && typeof value === "object" ? value as Partial<WindowUiState> : {};
  const petPosition = raw.petPosition && finite(raw.petPosition.x) && finite(raw.petPosition.y)
    ? { x: Math.round(raw.petPosition.x), y: Math.round(raw.petPosition.y) }
    : undefined;
  const workbenchBounds = raw.workbenchBounds &&
    finite(raw.workbenchBounds.x) &&
    finite(raw.workbenchBounds.y) &&
    finite(raw.workbenchBounds.width) &&
    finite(raw.workbenchBounds.height)
    ? {
        x: Math.round(raw.workbenchBounds.x),
        y: Math.round(raw.workbenchBounds.y),
        width: Math.max(1, Math.round(raw.workbenchBounds.width)),
        height: Math.max(1, Math.round(raw.workbenchBounds.height)),
      }
    : undefined;
  return {
    layoutVersion: 1,
    petPosition,
    workbenchBounds,
    workbenchMaximized: raw.workbenchMaximized === true,
    sidebarCollapsed: raw.sidebarCollapsed === true,
  };
}

export function clampWorkbenchBounds(
  bounds: WindowBounds,
  workArea: WindowBounds,
): WindowBounds {
  const width = Math.min(
    workArea.width,
    Math.max(WORKBENCH_MIN_SIZE.width, bounds.width),
  );
  const height = Math.min(
    workArea.height,
    Math.max(WORKBENCH_MIN_SIZE.height, bounds.height),
  );
  return {
    x: Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height),
    width,
    height,
  };
}
