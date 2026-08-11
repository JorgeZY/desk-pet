import { describe, expect, it } from "vitest";
import { clampWindowPosition } from "./pet-window";

describe("clampWindowPosition", () => {
  const workArea = { x: 100, y: 50, width: 1_200, height: 800 };
  const size = { width: 280, height: 330 };

  it("preserves the exact pet position when it is still visible", () => {
    expect(clampWindowPosition({ x: 947, y: 493 }, size, workArea)).toEqual({
      x: 947,
      y: 493,
    });
  });

  it("only moves the pet when the saved position is outside the work area", () => {
    expect(clampWindowPosition({ x: 1_240, y: 700 }, size, workArea)).toEqual({
      x: 1_020,
      y: 520,
    });
    expect(clampWindowPosition({ x: -80, y: -30 }, size, workArea)).toEqual({
      x: 100,
      y: 50,
    });
  });
});
