import { describe, expect, it } from "vitest";

describe("renderer DOM test environment", () => {
  it("provides the browser APIs used by Radix components", () => {
    expect(typeof window.matchMedia).toBe("function");
    expect(typeof window.scrollTo).toBe("function");
    expect(typeof window.PointerEvent).toBe("function");
    expect(typeof ResizeObserver).toBe("function");

    const element = document.createElement("button");
    expect(element.hasPointerCapture(1)).toBe(false);
    expect(() => element.setPointerCapture(1)).not.toThrow();
    expect(() => element.releasePointerCapture(1)).not.toThrow();
    expect(() => element.scrollIntoView()).not.toThrow();

    element.inert = true;
    expect(element.hasAttribute("inert")).toBe(true);
    element.inert = false;
    expect(element.hasAttribute("inert")).toBe(false);
  });
});
