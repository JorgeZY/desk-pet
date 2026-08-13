import {
  PET_CLIPS,
  PET_IDLE_ACTIONS,
  type PetIdleAction,
} from "./pet-clips";

export interface IdleActionScheduleOptions {
  initialDelayMs: readonly [number, number];
  repeatDelayMs: readonly [number, number];
  actions: readonly PetIdleAction[];
  random?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export const PET_IDLE_ACTION_TIMING: IdleActionScheduleOptions = {
  initialDelayMs: [4_000, 8_000],
  repeatDelayMs: [10_000, 18_000],
  actions: PET_IDLE_ACTIONS,
};

function randomUnit(random: () => number) {
  const sample = random();
  return Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5;
}

export function pickIdleActionDelay(
  range: readonly [number, number],
  random: () => number = Math.random,
) {
  const lower = Math.min(range[0], range[1]);
  const upper = Math.max(range[0], range[1]);
  return Math.round(lower + randomUnit(random) * (upper - lower));
}

export function pickIdleAction(
  actions: readonly PetIdleAction[],
  previous: PetIdleAction | null,
  random: () => number = Math.random,
) {
  if (!actions.length) return null;
  const candidates = actions.length > 1
    ? actions.filter((action) => action !== previous)
    : actions;
  const index = Math.min(
    candidates.length - 1,
    Math.floor(randomUnit(random) * candidates.length),
  );
  return candidates[index] ?? null;
}

export function startIdleActionScheduler(
  onActionChange: (action: PetIdleAction | null) => void,
  options: IdleActionScheduleOptions = PET_IDLE_ACTION_TIMING,
) {
  const random = options.random ?? Math.random;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  let stopped = false;
  let previousAction: PetIdleAction | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (delayRange: readonly [number, number]) => {
    timer = setTimer(() => {
      if (stopped) return;
      const action = pickIdleAction(options.actions, previousAction, random);
      if (!action) return;
      previousAction = action;
      onActionChange(action);
      timer = setTimer(() => {
        if (stopped) return;
        onActionChange(null);
        schedule(options.repeatDelayMs);
      }, PET_CLIPS[action].durationMs);
    }, pickIdleActionDelay(delayRange, random));
  };

  schedule(options.initialDelayMs);

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };
}
