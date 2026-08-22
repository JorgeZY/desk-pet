import { describe, expect, it } from "vitest";
import {
  CAPTION_WINDOW_DEFAULTS,
  clampCaptionBounds,
  defaultCaptionBounds,
  normalizeCaptionConfig,
} from "./caption-window";

describe("caption window configuration", () => {
  it("migrates defaults and clamps user-facing values", () => {
    expect(normalizeCaptionConfig(undefined)).toEqual({ layoutVersion: 3, fontSize: 22, opacity: 0.96, bounds: undefined });
    expect(normalizeCaptionConfig({ layoutVersion: 3, fontSize: 99, opacity: 0.2 })).toEqual({
      layoutVersion: 3,
      fontSize: 36,
      opacity: 0.96,
      bounds: undefined,
    });
  });

  it("converts old resizable bounds to the fixed caption size without moving their center or bottom", () => {
    expect(normalizeCaptionConfig({
      fontSize: 28,
      opacity: 0.92,
      bounds: { x: 580, y: 784, width: 760, height: 220 },
    }).bounds).toEqual({ x: 600, y: 896, width: 720, height: 108 });
    expect(normalizeCaptionConfig({
      layoutVersion: 3,
      fontSize: 28,
      bounds: { x: 100, y: 200, width: 900, height: 150 },
    })).toEqual({
      layoutVersion: 3,
      fontSize: 28,
      opacity: 0.96,
      bounds: { x: 190, y: 242, width: 720, height: 108 },
    });
  });

  it("rejects partial bounds", () => {
    expect(normalizeCaptionConfig({ bounds: { width: 700 } }).bounds).toBeUndefined();
  });

  it("restores the fixed window fully inside the closest work area", () => {
    expect(clampCaptionBounds(
      { x: -900, y: 1800, width: 900, height: 240 },
      { x: 100, y: 200, width: 1000, height: 700 },
    )).toEqual({ x: 100, y: 792, width: 720, height: 108 });
  });

  it("places the default window at the lower center of the primary display", () => {
    expect(defaultCaptionBounds({ x: 0, y: 0, width: 1920, height: 1040 })).toEqual({
      x: 600,
      y: 896,
      width: CAPTION_WINDOW_DEFAULTS.width,
      height: CAPTION_WINDOW_DEFAULTS.height,
    });
  });
});
