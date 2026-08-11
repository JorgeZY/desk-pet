export const PET_WINDOW_WIDTH = 280;
export const PET_WINDOW_BASE_HEIGHT = 330;

interface WindowPosition {
  x: number;
  y: number;
}

interface WindowSize {
  width: number;
  height: number;
}

interface WorkArea extends WindowPosition, WindowSize {}

export function clampWindowPosition(
  position: WindowPosition,
  size: WindowSize,
  workArea: WorkArea,
): WindowPosition {
  const maxX = Math.max(workArea.x, workArea.x + workArea.width - size.width);
  const maxY = Math.max(workArea.y, workArea.y + workArea.height - size.height);
  return {
    x: Math.min(Math.max(position.x, workArea.x), maxX),
    y: Math.min(Math.max(position.y, workArea.y), maxY),
  };
}
