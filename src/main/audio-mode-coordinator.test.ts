import { describe, expect, it, vi } from "vitest";
import type { CaptionState, SpeechState } from "../shared/types";
import {
  AudioModeCoordinator,
  type CaptionModeRuntime,
  type SpeechModeRuntime,
} from "./audio-mode-coordinator";

const speechState = (activeSessionId?: string): SpeechState => ({
  enabled: true,
  phase: activeSessionId ? "recording" : "ready",
  message: "ready",
  modelDirectory: "models/speech",
  activeSessionId,
  updatedAt: 1,
});

const captionState = (phase: CaptionState["phase"]): CaptionState => ({
  phase,
  message: "ready",
  modelDirectory: "models/speech",
  partial: "",
  segments: [],
  updatedAt: 1,
});

describe("AudioModeCoordinator", () => {
  it("stops live captions before starting microphone dictation", async () => {
    const order: string[] = [];
    const caption = {
      snapshot: captionState("capturing"),
      start: vi.fn(),
      stop: vi.fn(async () => { order.push("caption-stop"); return captionState("ready"); }),
    } as unknown as CaptionModeRuntime;
    const speech = {
      snapshot: speechState(),
      start: vi.fn(async () => { order.push("speech-start"); return { sessionId: "speech-1" }; }),
      cancel: vi.fn(),
    } as unknown as SpeechModeRuntime;

    await new AudioModeCoordinator(speech, caption).startSpeech("shortcut");

    expect(order).toEqual(["caption-stop", "speech-start"]);
  });

  it("cancels active dictation before starting live captions", async () => {
    const order: string[] = [];
    const speech = {
      snapshot: speechState("speech-1"),
      start: vi.fn(),
      cancel: vi.fn(async () => { order.push("speech-cancel"); return speechState(); }),
    } as unknown as SpeechModeRuntime;
    const caption = {
      snapshot: captionState("ready"),
      start: vi.fn(async () => { order.push("caption-start"); return captionState("capturing"); }),
      stop: vi.fn(),
    } as unknown as CaptionModeRuntime;

    await new AudioModeCoordinator(speech, caption).startCaption();

    expect(order).toEqual(["speech-cancel", "caption-start"]);
  });

  it("serializes overlapping mode switches", async () => {
    let releaseSpeech!: () => void;
    let activeSessionId: string | undefined;
    const speech = {
      get snapshot() { return speechState(activeSessionId); },
      start: vi.fn(async () => {
        await new Promise<void>((resolve) => { releaseSpeech = resolve; });
        activeSessionId = "speech-late";
        return { sessionId: activeSessionId };
      }),
      cancel: vi.fn(async (sessionId: string) => {
        expect(sessionId).toBe("speech-late");
        activeSessionId = undefined;
        return speechState();
      }),
    } as SpeechModeRuntime;
    const caption = {
      snapshot: captionState("ready"),
      start: vi.fn(async () => captionState("capturing")),
      stop: vi.fn(),
    } as unknown as CaptionModeRuntime;
    const coordinator = new AudioModeCoordinator(speech, caption);

    const startingSpeech = coordinator.startSpeech("button");
    const startingCaption = coordinator.startCaption();
    await vi.waitFor(() => expect(releaseSpeech).toBeTypeOf("function"));
    releaseSpeech();
    await Promise.all([startingSpeech, startingCaption]);

    expect(speech.cancel).toHaveBeenCalledWith("speech-late");
    expect(caption.start).toHaveBeenCalledOnce();
  });
});
