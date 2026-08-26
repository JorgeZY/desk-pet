import { describe, expect, it, vi } from "vitest";
import { createAsyncBeforeQuitHandler } from "./app-shutdown";

describe("createAsyncBeforeQuitHandler", () => {
  it("waits for cleanup once and allows the follow-up quit", async () => {
    let finishCleanup!: () => void;
    const cleanup = vi.fn(() => new Promise<void>((resolve) => { finishCleanup = resolve; }));
    const begin = vi.fn();
    const quit = vi.fn();
    const handler = createAsyncBeforeQuitHandler({ begin, cleanup, quit });
    const first = { preventDefault: vi.fn() };
    const duplicate = { preventDefault: vi.fn() };

    handler(first);
    handler(duplicate);
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
    expect(first.preventDefault).toHaveBeenCalledTimes(1);
    expect(duplicate.preventDefault).toHaveBeenCalledTimes(1);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();

    finishCleanup();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
    const followUp = { preventDefault: vi.fn() };
    handler(followUp);
    expect(followUp.preventDefault).not.toHaveBeenCalled();
  });

  it("reports a bounded timeout and still completes quitting", async () => {
    vi.useFakeTimers();
    try {
      const quit = vi.fn();
      const onError = vi.fn();
      const handler = createAsyncBeforeQuitHandler({
        begin: () => undefined,
        cleanup: () => new Promise<void>(() => undefined),
        quit,
        onError,
        timeoutMs: 50,
      });

      handler({ preventDefault: vi.fn() });
      await vi.advanceTimersByTimeAsync(50);
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({
        message: "应用退出清理在 50 ms 内未完成",
      }));
      expect(quit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still runs critical async cleanup when synchronous setup fails", async () => {
    const quit = vi.fn();
    const onError = vi.fn();
    const cleanup = vi.fn(async () => undefined);
    const handler = createAsyncBeforeQuitHandler({
      begin: () => { throw new Error("shortcut cleanup failed"); },
      cleanup,
      quit,
      onError,
    });

    handler({ preventDefault: vi.fn() });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "shortcut cleanup failed",
    }));
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
  });
});
