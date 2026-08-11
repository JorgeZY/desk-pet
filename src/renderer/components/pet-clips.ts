export type PetMood =
  | "idle"
  | "thinking"
  | "talking"
  | "sleeping"
  | "sad"
  | "listening"
  | "transcribing";

export const PET_IDLE_ACTIONS = [
  "grooming",
  "yawning",
  "ear-scratching",
] as const;

export type PetIdleAction = (typeof PET_IDLE_ACTIONS)[number];
export type PetVisualState = PetMood | PetIdleAction;

interface PetClip {
  src: string;
  loop: boolean;
  durationMs?: number;
}

export const PET_GROOMING_DURATION_MS = 2_900;
export const PET_YAWNING_DURATION_MS = 2_560;
export const PET_EAR_SCRATCHING_DURATION_MS = 2_500;

const clip = (name: string, options: Omit<PetClip, "src">): PetClip => ({
  src: `./pet/moods/pet-${name}-v1.gif`,
  ...options,
});

export const PET_CLIPS = {
  idle: clip("idle", { loop: true }),
  thinking: clip("thinking", { loop: true }),
  talking: clip("talking", { loop: true }),
  sleeping: clip("sleeping", { loop: true }),
  sad: clip("sad", { loop: true }),
  listening: clip("listening", { loop: true }),
  transcribing: clip("transcribing", { loop: true }),
  grooming: clip("grooming", { loop: false, durationMs: PET_GROOMING_DURATION_MS }),
  yawning: clip("yawning", { loop: false, durationMs: PET_YAWNING_DURATION_MS }),
  "ear-scratching": clip("ear-scratching", {
    loop: false,
    durationMs: PET_EAR_SCRATCHING_DURATION_MS,
  }),
} satisfies Record<PetVisualState, PetClip>;

export function resolvePetVisualState(
  mood: PetMood,
  idleAction: PetIdleAction | null,
): PetVisualState {
  return mood === "idle" && idleAction ? idleAction : mood;
}

export function petClipPlaybackSrc(state: PetVisualState, playbackId: string) {
  const media = PET_CLIPS[state];
  return media.loop
    ? media.src
    : `${media.src}?play=${encodeURIComponent(playbackId)}`;
}

const preloadRequests = new Map<string, Promise<void>>();

export function preloadPetClip(src: string) {
  if (typeof Image === "undefined") return Promise.resolve();
  const existing = preloadRequests.get(src);
  if (existing) return existing;

  const request = new Promise<void>((resolve) => {
    const image = new Image();
    image.onload = () => resolve();
    image.onerror = () => resolve();
    image.src = src;
  });
  preloadRequests.set(src, request);
  return request;
}

export function preloadLoopingPetClips() {
  for (const media of Object.values(PET_CLIPS)) {
    if (media.loop) void preloadPetClip(media.src);
  }
}
