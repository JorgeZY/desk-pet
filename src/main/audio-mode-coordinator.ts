import type {
  CaptionState,
  SpeechSessionSource,
  SpeechStartResult,
  SpeechState,
} from "../shared/types";

export interface SpeechModeRuntime {
  readonly snapshot: SpeechState;
  start(source: SpeechSessionSource): Promise<SpeechStartResult | null>;
  cancel(sessionId: string): Promise<SpeechState>;
}

export interface CaptionModeRuntime {
  readonly snapshot: CaptionState;
  start(): Promise<CaptionState>;
  stop(message?: string): Promise<CaptionState>;
}

export class AudioModeCoordinator {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly speech: SpeechModeRuntime,
    private readonly caption: CaptionModeRuntime,
  ) {}

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation);
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  startSpeech(source: SpeechSessionSource): Promise<SpeechStartResult | null> {
    return this.run(async () => {
      if (this.caption.snapshot.phase === "capturing") {
        await this.caption.stop("已切换到麦克风听写。");
      }
      return this.speech.start(source);
    });
  }

  startCaption(beforeStart?: () => void): Promise<CaptionState> {
    return this.run(async () => {
      const activeSpeechId = this.speech.snapshot.activeSessionId;
      if (activeSpeechId) await this.speech.cancel(activeSpeechId);
      beforeStart?.();
      return this.caption.start();
    });
  }
}
