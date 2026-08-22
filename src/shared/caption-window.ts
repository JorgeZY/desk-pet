import type { CaptionConfig, CaptionWindowBounds } from "./types";

export const CAPTION_WINDOW_DEFAULTS = {
  width: 720,
  height: 108,
} as const;

export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function clampCaptionBounds(
  bounds: CaptionWindowBounds,
  workArea: WorkArea,
): CaptionWindowBounds {
  const width = Math.min(CAPTION_WINDOW_DEFAULTS.width, workArea.width);
  const height = Math.min(CAPTION_WINDOW_DEFAULTS.height, workArea.height);
  return {
    width,
    height,
    x: Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height),
  };
}

export function defaultCaptionBounds(workArea: WorkArea): CaptionWindowBounds {
  const width = Math.min(CAPTION_WINDOW_DEFAULTS.width, workArea.width);
  const height = Math.min(CAPTION_WINDOW_DEFAULTS.height, workArea.height);
  return {
    width,
    height,
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + workArea.height - height - 36,
  };
}

export function normalizeCaptionConfig(value: unknown): CaptionConfig {
  const raw = value && typeof value === "object" ? value as Partial<CaptionConfig> : {};
  const number = (candidate: unknown, fallback: number): number =>
    typeof candidate === "number" && Number.isFinite(candidate) ? candidate : fallback;
  const rawBounds = raw.bounds && typeof raw.bounds === "object"
    ? raw.bounds as Partial<CaptionWindowBounds>
    : undefined;
  const bounds = rawBounds && [rawBounds.x, rawBounds.y, rawBounds.width, rawBounds.height]
    .every((candidate) => typeof candidate === "number" && Number.isFinite(candidate))
    ? {
        x: Math.round(rawBounds.x! + (rawBounds.width! - CAPTION_WINDOW_DEFAULTS.width) / 2),
        y: Math.round(rawBounds.y! + rawBounds.height! - CAPTION_WINDOW_DEFAULTS.height),
        width: CAPTION_WINDOW_DEFAULTS.width,
        height: CAPTION_WINDOW_DEFAULTS.height,
      }
    : undefined;

  return {
    layoutVersion: 3,
    fontSize: raw.layoutVersion === 3
      ? Math.min(36, Math.max(16, Math.round(number(raw.fontSize, 22))))
      : 22,
    opacity: 0.96,
    bounds,
  };
}
