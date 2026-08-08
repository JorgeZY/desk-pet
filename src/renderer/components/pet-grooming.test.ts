import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PET_GROOMING_TIMING,
  pickGroomingDelay,
  startGroomingScheduler,
} from "./pet-grooming";

describe("pet grooming scheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the initial delay and reschedules only after the action finishes", () => {
    vi.useFakeTimers();
    const onActiveChange = vi.fn();
    const stop = startGroomingScheduler(onActiveChange, {
      ...PET_GROOMING_TIMING,
      random: () => 0,
    });

    vi.advanceTimersByTime(PET_GROOMING_TIMING.initialDelayMs[0] - 1);
    expect(onActiveChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onActiveChange).toHaveBeenLastCalledWith(true);

    vi.advanceTimersByTime(PET_GROOMING_TIMING.durationMs);
    expect(onActiveChange).toHaveBeenLastCalledWith(false);

    vi.advanceTimersByTime(PET_GROOMING_TIMING.repeatDelayMs[0]);
    expect(onActiveChange).toHaveBeenLastCalledWith(true);
    expect(onActiveChange).toHaveBeenCalledTimes(3);
    stop();
  });

  it("cancels the pending or active action without scheduling another one", () => {
    vi.useFakeTimers();
    const pendingChange = vi.fn();
    const stopPending = startGroomingScheduler(pendingChange, {
      ...PET_GROOMING_TIMING,
      random: () => 0,
    });
    stopPending();
    vi.runAllTimers();
    expect(pendingChange).not.toHaveBeenCalled();

    const activeChange = vi.fn();
    const stopActive = startGroomingScheduler(activeChange, {
      ...PET_GROOMING_TIMING,
      random: () => 0,
    });
    vi.advanceTimersByTime(PET_GROOMING_TIMING.initialDelayMs[0]);
    expect(activeChange).toHaveBeenLastCalledWith(true);
    stopActive();
    vi.runAllTimers();
    expect(activeChange).toHaveBeenCalledTimes(1);
  });

  it("clamps random samples to the configured delay range", () => {
    expect(pickGroomingDelay([10, 20], () => -1)).toBe(10);
    expect(pickGroomingDelay([10, 20], () => 1.5)).toBe(20);
    expect(pickGroomingDelay([20, 10], () => 0.5)).toBe(15);
  });
});
