import { PET_GROOMING_DURATION_MS } from "./pet-clips";

export interface GroomingScheduleOptions {
  initialDelayMs: readonly [number, number];
  repeatDelayMs: readonly [number, number];
  durationMs: number;
  random?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export const PET_GROOMING_TIMING = {
  initialDelayMs: [8_000, 15_000] as const,
  repeatDelayMs: [24_000, 42_000] as const,
  durationMs: PET_GROOMING_DURATION_MS,
};

export function pickGroomingDelay(
  range: readonly [number, number],
  random: () => number = Math.random,
) {
  const lower = Math.min(range[0], range[1]);
  const upper = Math.max(range[0], range[1]);
  const sample = random();
  const unit = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5;
  return Math.round(lower + unit * (upper - lower));
}

export function startGroomingScheduler(
  onActiveChange: (active: boolean) => void,
  options: GroomingScheduleOptions = PET_GROOMING_TIMING,
) {
  const random = options.random ?? Math.random;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (delayRange: readonly [number, number]) => {
    timer = setTimer(() => {
      if (stopped) return;
      onActiveChange(true);
      timer = setTimer(() => {
        if (stopped) return;
        onActiveChange(false);
        schedule(options.repeatDelayMs);
      }, options.durationMs);
    }, pickGroomingDelay(delayRange, random));
  };

  schedule(options.initialDelayMs);

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };
}
