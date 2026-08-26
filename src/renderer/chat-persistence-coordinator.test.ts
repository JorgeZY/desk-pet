import { afterEach, describe, expect, it, vi } from "vitest";
import {
  flushChatPersistence,
  registerChatPersistenceFlush,
  trackChatPersistence,
} from "./chat-persistence-coordinator";

afterEach(async () => {
  trackChatPersistence(Promise.resolve());
  await flushChatPersistence();
});

describe("chat persistence coordinator", () => {
  it("waits for the latest save retained after a panel unmount", async () => {
    let resolveSave!: () => void;
    trackChatPersistence(new Promise<void>((resolve) => { resolveSave = resolve; }));
    const flushed = vi.fn();
    const waiting = flushChatPersistence().then(flushed);

    await Promise.resolve();
    expect(flushed).not.toHaveBeenCalled();
    resolveSave();
    await waiting;
    expect(flushed).toHaveBeenCalledOnce();
  });

  it("does not lose an older pending save when a new panel tracks a resolved save", async () => {
    let resolveOldSave!: () => void;
    trackChatPersistence(new Promise<void>((resolve) => { resolveOldSave = resolve; }));
    trackChatPersistence(Promise.resolve());
    const flushed = vi.fn();
    const waiting = flushChatPersistence().then(flushed);

    await Promise.resolve();
    expect(flushed).not.toHaveBeenCalled();
    resolveOldSave();
    await waiting;
    expect(flushed).toHaveBeenCalledOnce();
  });

  it("allows a successful retry to clear an earlier failure for the same conversation", async () => {
    const failed = trackChatPersistence(
      Promise.reject(new Error("database busy")),
      "conversation-retry",
    );
    await expect(failed).rejects.toThrow("database busy");
    trackChatPersistence(Promise.resolve(), "conversation-retry");

    await expect(flushChatPersistence()).resolves.toBeUndefined();
  });

  it("reports a raw save failure even when the panel save chain catches it", async () => {
    let rejectSave!: (error: Error) => void;
    const rawSave = new Promise<void>((_resolve, reject) => { rejectSave = reject; });
    trackChatPersistence(rawSave, "conversation-in-flight");
    const caughtSaveChain = rawSave.catch(() => undefined);
    const flushing = flushChatPersistence();

    rejectSave(new Error("write failed during quit"));
    await caughtSaveChain;
    await expect(flushing).rejects.toThrow("chat history saves failed");

    trackChatPersistence(Promise.resolve(), "conversation-in-flight");
    await expect(flushChatPersistence()).resolves.toBeUndefined();
  });

  it("runs the mounted panel flush before acknowledging persistence", async () => {
    let resolveSave!: () => void;
    const unregister = registerChatPersistenceFlush(async () => {
      await trackChatPersistence(new Promise<void>((resolve) => { resolveSave = resolve; }));
    });
    const waiting = flushChatPersistence();
    await Promise.resolve();
    resolveSave();
    await waiting;
    unregister();
  });
});
