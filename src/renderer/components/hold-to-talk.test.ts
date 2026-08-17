import { describe, expect, it, vi } from "vitest";
import { createHoldToTalkController } from "./hold-to-talk";

describe("hold-to-talk controller", () => {
  it("starts once while held and stops once when released", async () => {
    const start = vi.fn(async () => "speech-1");
    const stop = vi.fn(async () => undefined);
    const controller = createHoldToTalkController();

    await Promise.all([
      controller.press({ start, stop }),
      controller.press({ start, stop }),
    ]);
    await controller.release();
    await controller.release();

    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith("speech-1");
  });

  it("stops a session that starts after the hold was already released", async () => {
    let resolveStart: ((sessionId: string) => void) | undefined;
    const start = vi.fn(() => new Promise<string>((resolve) => {
      resolveStart = resolve;
    }));
    const stop = vi.fn(async () => undefined);
    const controller = createHoldToTalkController();

    const pendingPress = controller.press({ start, stop });
    await controller.release();
    resolveStart?.("speech-late");
    await pendingPress;

    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith("speech-late");
  });

  it("reports start and stop failures without leaking rejected promises", async () => {
    const errors: unknown[] = [];
    const controller = createHoldToTalkController((error) => errors.push(error));
    const startError = new Error("start failed");
    await controller.press({
      start: async () => {
        throw startError;
      },
      stop: async () => undefined,
    });

    const stopError = new Error("stop failed");
    await controller.press({
      start: async () => "speech-2",
      stop: async () => {
        throw stopError;
      },
    });
    await controller.release();

    expect(errors).toEqual([startError, stopError]);
  });
});
