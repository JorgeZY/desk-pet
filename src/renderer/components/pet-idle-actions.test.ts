import { afterEach, describe, expect, it, vi } from "vitest";
import { PET_CLIPS } from "./pet-clips";
import {
  PET_IDLE_ACTION_TIMING,
  pickIdleAction,
  pickIdleActionDelay,
  startIdleActionScheduler,
} from "./pet-idle-actions";

describe("pet idle action scheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits, plays a complete action, and avoids an immediate repeat", () => {
    vi.useFakeTimers();
    const onActionChange = vi.fn();
    const stop = startIdleActionScheduler(onActionChange, {
      ...PET_IDLE_ACTION_TIMING,
      random: () => 0,
    });

    vi.advanceTimersByTime(PET_IDLE_ACTION_TIMING.initialDelayMs[0] - 1);
    expect(onActionChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onActionChange).toHaveBeenLastCalledWith("grooming");

    vi.advanceTimersByTime(PET_CLIPS.grooming.durationMs!);
    expect(onActionChange).toHaveBeenLastCalledWith(null);

    vi.advanceTimersByTime(PET_IDLE_ACTION_TIMING.repeatDelayMs[0]);
    expect(onActionChange).toHaveBeenLastCalledWith("yawning");
    expect(onActionChange).toHaveBeenCalledTimes(3);
    stop();
  });

  it("cancels a pending or active action without scheduling another one", () => {
    vi.useFakeTimers();
    const pendingChange = vi.fn();
    const stopPending = startIdleActionScheduler(pendingChange, {
      ...PET_IDLE_ACTION_TIMING,
      random: () => 0,
    });
    stopPending();
    vi.runAllTimers();
    expect(pendingChange).not.toHaveBeenCalled();

    const activeChange = vi.fn();
    const stopActive = startIdleActionScheduler(activeChange, {
      ...PET_IDLE_ACTION_TIMING,
      random: () => 0,
    });
    vi.advanceTimersByTime(PET_IDLE_ACTION_TIMING.initialDelayMs[0]);
    expect(activeChange).toHaveBeenLastCalledWith("grooming");
    stopActive();
    vi.runAllTimers();
    expect(activeChange).toHaveBeenCalledTimes(1);
  });

  it("selects from the action pack without repeating the previous action", () => {
    expect(pickIdleAction(["grooming"], "grooming", () => 1)).toBe("grooming");
    expect(pickIdleAction(PET_IDLE_ACTION_TIMING.actions, "grooming", () => 0)).toBe("yawning");
    expect(pickIdleAction(PET_IDLE_ACTION_TIMING.actions, "grooming", () => 1)).toBe("perking-up");
    expect(pickIdleAction([], null)).toBeNull();
  });

  it("rotates more frequently while keeping enough rest between actions", () => {
    expect(PET_IDLE_ACTION_TIMING.initialDelayMs).toEqual([4_000, 8_000]);
    expect(PET_IDLE_ACTION_TIMING.repeatDelayMs).toEqual([10_000, 18_000]);
    expect(PET_IDLE_ACTION_TIMING.actions).toHaveLength(7);
  });

  it("clamps random delay samples to the configured range", () => {
    expect(pickIdleActionDelay([10, 20], () => -1)).toBe(10);
    expect(pickIdleActionDelay([10, 20], () => 1.5)).toBe(20);
    expect(pickIdleActionDelay([20, 10], () => 0.5)).toBe(15);
  });
});
