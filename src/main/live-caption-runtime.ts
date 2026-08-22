import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  CaptionDownloadProgress,
  CaptionEvent,
  CaptionSegment,
  CaptionState,
} from "../shared/types";
import {
  WorkerLiveCaptionBackend,
  type LiveCaptionBackend,
  type LiveCaptionBackendFactory,
} from "./live-caption-worker-backend";
import type { CaptionWorkerEvent } from "./live-caption-worker-protocol";
import { SpeechModelManager } from "./speech-model-manager";

const MAX_HISTORY_SEGMENTS = 1;
const MAX_CAPTION_THREADS = 2;
const PARTIAL_PUBLISH_INTERVAL_MS = 120;

interface ActiveCaptionSession {
  id: string;
  backend: LiveCaptionBackend;
  inputSampleRate?: number;
  rawPartial: string;
  rawStartMs: number;
  rawEndMs: number;
  lastPartialPublishedAt: number;
  partialTimer?: ReturnType<typeof setTimeout>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validCaption(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

export class LiveCaptionRuntime extends EventEmitter {
  private state: CaptionState;
  private active?: ActiveCaptionSession;
  private prepareController?: AbortController;

  constructor(
    private threads: number,
    private readonly models: SpeechModelManager,
    private readonly backendFactory: LiveCaptionBackendFactory = () =>
      new WorkerLiveCaptionBackend(),
  ) {
    super();
    this.threads = Math.min(MAX_CAPTION_THREADS, Math.max(1, Math.round(threads)));
    this.state = {
      phase: "not-installed",
      message: "英文实时字幕模型尚未安装。",
      modelDirectory: models.captionPaths.directory,
      partial: "",
      segments: [],
      updatedAt: Date.now(),
    };
  }

  get snapshot(): CaptionState {
    return {
      ...this.state,
      segments: this.state.segments.map((segment) => ({ ...segment })),
      progress: this.state.progress ? { ...this.state.progress } : undefined,
    };
  }

  private publish(next: Partial<CaptionState>): CaptionState {
    this.state = { ...this.state, ...next, updatedAt: Date.now() };
    this.emit("state", this.snapshot);
    return this.snapshot;
  }

  private publishEvent(event: CaptionEvent): void {
    this.emit("event", event);
  }

  updateThreads(threads: number): void {
    this.threads = Math.min(MAX_CAPTION_THREADS, Math.max(1, Math.round(threads)));
  }

  async initializeAvailability(): Promise<CaptionState> {
    const ready = await this.models.isCaptionReady();
    return this.publish(ready
      ? {
          phase: "ready",
          message: "英文实时字幕已就绪。",
          modelDirectory: this.models.captionPaths.directory,
          error: undefined,
        }
      : {
          phase: "not-installed",
          message: "需要下载约 650 MB 的本地英文实时字幕模型。",
          modelDirectory: this.models.captionPaths.directory,
        });
  }

  async prepare(force = false): Promise<CaptionState> {
    if (this.prepareController) return this.snapshot;
    this.prepareController = new AbortController();
    this.publish({
      phase: "downloading",
      message: "正在下载英文实时字幕模型…",
      modelDirectory: this.models.captionPaths.directory,
      error: undefined,
    });
    try {
      await this.models.prepareCaption(
        this.prepareController.signal,
        (progress: CaptionDownloadProgress) => this.publish({ progress }),
        force,
      );
      return this.publish({
        phase: "ready",
        message: "英文实时字幕模型已就绪。",
        modelDirectory: this.models.captionPaths.directory,
        progress: undefined,
        error: undefined,
      });
    } catch (error) {
      const text = errorMessage(error);
      this.publish({ phase: "error", message: "英文实时字幕模型准备失败。", error: text, progress: undefined });
      throw error;
    } finally {
      this.prepareController = undefined;
    }
  }

  async start(): Promise<CaptionState> {
    if (this.active) return this.snapshot;
    if (!(await this.models.isCaptionReady())) {
      this.publish({ phase: "not-installed", message: "需要先下载英文实时字幕模型。" });
      this.publishEvent({ type: "setup-required" });
      return this.snapshot;
    }

    const id = randomUUID();
    const backend = this.backendFactory();
    const session: ActiveCaptionSession = {
      id,
      backend,
      rawPartial: "",
      rawStartMs: 0,
      rawEndMs: 0,
      lastPartialPublishedAt: 0,
    };
    this.active = session;
    try {
      this.publish({ phase: "loading", message: "正在加载英文实时字幕模型…", error: undefined });
      const paths = this.models.captionPaths;
      await backend.start({
        encoder: paths.encoder,
        decoder: paths.decoder,
        joiner: paths.joiner,
        tokens: paths.tokens,
        featureDim: paths.featureDim,
        threads: this.threads,
      }, (event) => this.handleWorkerEvent(id, event));
      if (this.active?.id !== id) throw new Error("实时字幕启动已取消。");
      this.publish({
        phase: "capturing",
        message: "正在识别系统播放声音…",
        sessionId: id,
        partial: "",
        error: undefined,
      });
      this.publishEvent({ type: "started", sessionId: id });
      return this.snapshot;
    } catch (error) {
      if (this.active?.id === id) {
        this.active = undefined;
        await backend.terminate();
        const text = errorMessage(error);
        this.publish({ phase: "error", message: "实时字幕启动失败。", error: text, sessionId: undefined });
        this.publishEvent({ type: "error", message: text });
      }
      throw error;
    }
  }

  acceptAudio(sessionId: string, inputSampleRate: number, samples: Float32Array): boolean {
    const session = this.active;
    if (!session || session.id !== sessionId || this.state.phase !== "capturing") return false;
    if (!Number.isFinite(inputSampleRate) || inputSampleRate < 8_000 || inputSampleRate > 192_000) return false;
    if (!(samples instanceof Float32Array) || samples.length === 0 || samples.length > inputSampleRate * 2) return false;
    if (session.inputSampleRate !== undefined && session.inputSampleRate !== inputSampleRate) {
      void this.fail(new Error("系统输出采样率已变化，请重新启动实时字幕。"));
      return false;
    }
    session.inputSampleRate = inputSampleRate;
    try {
      session.backend.acceptAudio(inputSampleRate, samples);
      return true;
    } catch (error) {
      void this.fail(error);
      return false;
    }
  }

  private handleWorkerEvent(sessionId: string, event: CaptionWorkerEvent): void {
    const session = this.active;
    if (!session || session.id !== sessionId) return;
    if (event.type === "partial") {
      session.rawPartial = event.text;
      session.rawStartMs = event.startMs;
      session.rawEndMs = event.endMs;
      this.schedulePartial(session);
    } else if (event.type === "segment") {
      this.commitWorkerSegment(session, event.text, event.startMs, event.endMs);
    } else if (event.type === "error") {
      void this.fail(new Error(event.message));
    }
  }

  private schedulePartial(session: ActiveCaptionSession): void {
    if (session.partialTimer) return;
    const elapsed = Date.now() - session.lastPartialPublishedAt;
    if (elapsed >= PARTIAL_PUBLISH_INTERVAL_MS) {
      this.flushPartial(session);
      return;
    }
    session.partialTimer = setTimeout(() => {
      session.partialTimer = undefined;
      if (this.active?.id === session.id) this.flushPartial(session);
    }, PARTIAL_PUBLISH_INTERVAL_MS - elapsed);
  }

  private flushPartial(session: ActiveCaptionSession): void {
    if (session.rawPartial === this.state.partial) return;
    session.lastPartialPublishedAt = Date.now();
    this.publish({ partial: session.rawPartial });
    this.publishEvent({ type: "partial", sessionId: session.id, text: session.rawPartial });
  }

  private commitWorkerSegment(
    session: ActiveCaptionSession,
    text: string,
    startMs: number,
    endMs: number,
  ): void {
    this.clearPartialTimer(session);
    session.rawPartial = "";
    session.rawStartMs = endMs;
    session.rawEndMs = endMs;
    if (validCaption(text)) {
      const segment: CaptionSegment = { id: randomUUID(), text: text.trim(), startMs, endMs };
      const previous = this.state.segments.at(-1);
      const duplicate = previous?.text === segment.text
        && previous.startMs === segment.startMs
        && previous.endMs === segment.endMs;
      const segments = duplicate
        ? this.state.segments
        : [...this.state.segments, segment].slice(-MAX_HISTORY_SEGMENTS);
      this.publish({ segments, partial: "" });
      if (!duplicate) this.publishEvent({ type: "segment", sessionId: session.id, segment });
    } else {
      this.publish({ partial: "" });
    }
  }

  private commitRawPartial(session: ActiveCaptionSession): void {
    if (!validCaption(session.rawPartial)) return;
    this.commitWorkerSegment(
      session,
      session.rawPartial,
      session.rawStartMs,
      session.rawEndMs,
    );
  }

  private clearPartialTimer(session: ActiveCaptionSession): void {
    if (session.partialTimer) clearTimeout(session.partialTimer);
    session.partialTimer = undefined;
  }

  async stop(message = "实时字幕已停止。"): Promise<CaptionState> {
    const session = this.active;
    if (session) {
      this.clearPartialTimer(session);
      try {
        await session.backend.stop();
      } catch {
        this.commitRawPartial(session);
      }
      await session.backend.terminate();
      if (this.active?.id === session.id) this.active = undefined;
    }
    this.publish({
      phase: "ready",
      message,
      sessionId: undefined,
      partial: "",
      inputAudioMs: undefined,
      inputLevel: undefined,
      error: undefined,
    });
    this.publishEvent({ type: "stopped", sessionId: session?.id, message });
    return this.snapshot;
  }

  captureEnded(message: string): CaptionState {
    const session = this.active;
    const sessionId = session?.id;
    if (session) {
      this.clearPartialTimer(session);
      this.commitRawPartial(session);
      this.active = undefined;
      void session.backend.terminate();
    }
    this.publish({
      phase: "error",
      message,
      error: message,
      sessionId: undefined,
      partial: "",
      inputAudioMs: undefined,
      inputLevel: undefined,
    });
    this.publishEvent({ type: "error", sessionId, message });
    return this.snapshot;
  }

  clear(): CaptionState {
    return this.publish({ segments: [], partial: "" });
  }

  private async fail(error: unknown): Promise<void> {
    const text = errorMessage(error);
    const session = this.active;
    const sessionId = session?.id;
    if (session) {
      this.clearPartialTimer(session);
      this.commitRawPartial(session);
      this.active = undefined;
    }
    this.publish({
      phase: "error",
      message: "系统音频识别失败。",
      error: text,
      sessionId: undefined,
      partial: "",
      inputAudioMs: undefined,
      inputLevel: undefined,
    });
    this.publishEvent({ type: "error", sessionId, message: text });
    if (session) await session.backend.terminate();
  }

  async dispose(): Promise<void> {
    this.prepareController?.abort();
    if (this.active) await this.stop("实时字幕已关闭。");
    this.removeAllListeners();
  }
}
