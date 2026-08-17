import type { SpeechPhase } from "../../shared/types";

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
  "daydreaming",
  "cheering",
  "dozing",
  "perking-up",
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
export const PET_DAYDREAMING_DURATION_MS = 2_400;
export const PET_CHEERING_DURATION_MS = 1_760;
export const PET_DOZING_DURATION_MS = 3_000;
export const PET_PERKING_UP_DURATION_MS = 2_200;

const clip = (name: string, options: Omit<PetClip, "src">): PetClip => ({
  src: `./pet/moods/pet-${name}-v1.gif`,
  ...options,
});

const refreshedClipSource = (name: string, revision: string) =>
  `./pet/moods/pet-${name}-v1.gif?rev=${revision}`;

const THINKING_CLIP_SOURCE = refreshedClipSource("thinking", "8a452840090b");
const TALKING_CLIP_SOURCE = refreshedClipSource("talking", "726019776518");
const SLEEPING_CLIP_SOURCE = refreshedClipSource("sleeping", "af8c61e0db95");
const LISTENING_CLIP_SOURCE = refreshedClipSource("listening", "0c4109066f28");

const reusedMoodClip = (
  source: string,
  durationMs: number,
): PetClip => ({
  src: source,
  loop: false,
  durationMs,
});

export const PET_CLIPS = {
  idle: clip("idle", { loop: true }),
  thinking: { src: THINKING_CLIP_SOURCE, loop: true },
  talking: { src: TALKING_CLIP_SOURCE, loop: true },
  sleeping: { src: SLEEPING_CLIP_SOURCE, loop: true },
  sad: clip("sad", { loop: true }),
  listening: { src: LISTENING_CLIP_SOURCE, loop: true },
  transcribing: clip("transcribing", { loop: true }),
  grooming: clip("grooming", { loop: false, durationMs: PET_GROOMING_DURATION_MS }),
  yawning: clip("yawning", { loop: false, durationMs: PET_YAWNING_DURATION_MS }),
  "ear-scratching": clip("ear-scratching", {
    loop: false,
    durationMs: PET_EAR_SCRATCHING_DURATION_MS,
  }),
  daydreaming: reusedMoodClip(
    THINKING_CLIP_SOURCE,
    PET_DAYDREAMING_DURATION_MS,
  ),
  cheering: reusedMoodClip(
    TALKING_CLIP_SOURCE,
    PET_CHEERING_DURATION_MS,
  ),
  dozing: reusedMoodClip(
    SLEEPING_CLIP_SOURCE,
    PET_DOZING_DURATION_MS,
  ),
  "perking-up": reusedMoodClip(
    LISTENING_CLIP_SOURCE,
    PET_PERKING_UP_DURATION_MS,
  ),
} satisfies Record<PetVisualState, PetClip>;

export function resolvePetVisualState(
  mood: PetMood,
  idleAction: PetIdleAction | null,
): PetVisualState {
  return mood === "idle" && idleAction ? idleAction : mood;
}

export function resolveSpeechPetClipMood(phase: SpeechPhase): PetMood | undefined {
  // Recording keeps the calm idle body and expresses listening through the
  // SVG waves/bell. This prevents speech input from resembling a talking GIF.
  return phase === "recording" ? "idle" : undefined;
}

export function petClipPlaybackSrc(state: PetVisualState, playbackId: string) {
  const media = PET_CLIPS[state];
  return media.loop
    ? media.src
    : `${media.src}${media.src.includes("?") ? "&" : "?"}play=${encodeURIComponent(playbackId)}`;
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
