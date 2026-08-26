import { describe, expect, it, vi } from "vitest";
import {
  confirmWorkbenchNavigation,
  shouldUpdateRendererView,
} from "./workbench-navigation";

describe("confirmWorkbenchNavigation", () => {
  it("does not interrupt navigation when settings are clean", () => {
    const confirmDiscard = vi.fn(() => false);

    expect(confirmWorkbenchNavigation("settings", "chat", false, confirmDiscard)).toBe(true);
    expect(confirmDiscard).not.toHaveBeenCalled();
  });

  it("keeps dirty settings open when discard is rejected", () => {
    const confirmDiscard = vi.fn(() => false);

    expect(confirmWorkbenchNavigation("settings", "pet", true, confirmDiscard)).toBe(false);
    expect(confirmDiscard).toHaveBeenCalledOnce();
  });

  it("allows dirty settings to close after confirmation", () => {
    expect(confirmWorkbenchNavigation("settings", "chat", true, () => true)).toBe(true);
  });
});

describe("shouldUpdateRendererView", () => {
  it("keeps both long-lived renderers mounted when switching native windows", () => {
    expect(shouldUpdateRendererView("workbench", "pet")).toBe(false);
    expect(shouldUpdateRendererView("pet", "chat")).toBe(false);
    expect(shouldUpdateRendererView("workbench", "chat")).toBe(true);
    expect(shouldUpdateRendererView("workbench", "settings")).toBe(true);
  });
});
