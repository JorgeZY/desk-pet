import { describe, expect, it, vi } from "vitest";
import { copyTextWithFallback } from "./clipboard";

describe("copyTextWithFallback", () => {
  it("prefers the Electron preload clipboard API", async () => {
    const desktopCopyText = vi.fn(async () => undefined);
    const browserCopyText = vi.fn(async () => undefined);

    await copyTextWithFallback("answer", { desktopCopyText, browserCopyText });

    expect(desktopCopyText).toHaveBeenCalledWith("answer");
    expect(browserCopyText).not.toHaveBeenCalled();
  });

  it("uses the browser clipboard when an older preload has no copyText method", async () => {
    const browserCopyText = vi.fn(async () => undefined);

    await copyTextWithFallback("answer", { browserCopyText });

    expect(browserCopyText).toHaveBeenCalledWith("answer");
  });

  it("uses the DOM fallback when modern clipboard APIs fail", async () => {
    const browserCopyText = vi.fn(async () => {
      throw new Error("permission denied");
    });
    const legacyCopyText = vi.fn(() => true);

    await copyTextWithFallback("answer", { browserCopyText, legacyCopyText });

    expect(legacyCopyText).toHaveBeenCalledWith("answer");
  });

  it("reports an unsupported environment when no copy path exists", async () => {
    await expect(copyTextWithFallback("answer", {})).rejects.toThrow(
      "当前环境不支持复制到剪贴板",
    );
  });
});
