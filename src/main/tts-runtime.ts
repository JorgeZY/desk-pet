import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ChatEvent, TtsConfig, TtsDownloadProgress, TtsState } from "../shared/types";
import type { TtsModelManager } from "./tts-model-manager";
import { cleanTtsText, isSpeakableTtsText, SentenceAccumulator, splitTtsSentences } from "./tts-text";

export interface TtsGeneratedAudio {
  samples: Float32Array;
  sampleRate: number;
}

export interface TtsGenerationProgress {
  samples: Float32Array;
  progress: number;
}

export interface OfflineTtsLike {
  sampleRate: number;
  numSpeakers: number;
  generateAsync(input: {
    text: string;
    sid?: number;
    speed?: number;
    enableExternalBuffer?: boolean;
    onProgress?: (info: TtsGenerationProgress) => number | boolean | void;
  }): Promise<TtsGeneratedAudio>;
}

export interface TtsSherpaModule {
  OfflineTts: {
    createAsync(config: Record<string, unknown>): Promise<OfflineTtsLike>;
  };
}

export interface DedicatedSpeakerLike {
  writeAsync(chunk: Buffer): Promise<void>;
  drainAsync(): Promise<void>;
  stop(): void;
  readonly underrunCount: number;
}

export interface DedicatedSpeakerModule {
  Speaker: {
    open(options: {
      sampleRate: number;
      channels: number;
      dtype: "float32";
    }): Promise<DedicatedSpeakerLike>;
  };
}

export interface TtsRuntimeOptions {
  threads?: number;
  loadSherpa?: () => Promise<TtsSherpaModule>;
  loadSpeaker?: () => Promise<DedicatedSpeakerModule>;
  /** Called before each sentence starts playing; truthy means stay silent. */
  shouldSilence?: () => boolean;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultLoadSherpa(): Promise<TtsSherpaModule> {
  return Promise.resolve(require("sherpa-onnx-node") as TtsSherpaModule);
}

function defaultLoadSpeaker(): Promise<DedicatedSpeakerModule> {
  return Promise.resolve(require("decibri") as DedicatedSpeakerModule);
}

interface QueueItem {
  requestId: string;
  text: string;
}

const PREVIEW_REQUEST_ID = "preview";
// A few hundred inserted samples can occur while WASAPI starts. Only report
// sustained underruns that could be audible (about 23 ms at 44.1 kHz).
const REPORTABLE_UNDERRUN_SAMPLES = 1024;

interface DedicatedPlaybackOptions {
  speaker: DedicatedSpeakerLike;
  shouldStop: () => boolean;
}

/**
 * Owns a decibri speaker for one playback generation. PCM chunks are copied
 * before leaving the sherpa callback, then queued through decibri's native
 * async backpressure path in strict order. `drain()` resolves only after the
 * device has played the queued tail.
 */
export class DedicatedPlayback {
  private pending: Promise<void> = Promise.resolve();
  private error?: Error;
  private stopped = false;

  constructor(private readonly options: DedicatedPlaybackOptions) {}

  get underrunCount(): number {
    return this.options.speaker.underrunCount;
  }

  push(samples: Float32Array): void {
    if (this.stopped || !samples.length) return;
    const bytes = Buffer.allocUnsafe(samples.byteLength);
    bytes.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
    this.pending = this.pending
      .then(async () => {
        if (this.stopped || this.options.shouldStop()) return;
        await this.options.speaker.writeAsync(bytes);
      })
      .catch((error) => {
        this.error = error instanceof Error ? error : new Error(String(error));
        this.stop();
      });
  }

  async drain(): Promise<void> {
    await this.pending;
    if (this.error) throw this.error;
    if (this.stopped || this.options.shouldStop()) return;
    await this.options.speaker.drainAsync();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.options.speaker.stop();
    } catch {
      // The native stream may already be closed after a device failure.
    }
  }
}

export class TtsRuntime extends EventEmitter {
  private state: TtsState;
  private config: TtsConfig;
  private readonly threads: number;
  private readonly loadSherpa: () => Promise<TtsSherpaModule>;
  private readonly loadSpeaker: () => Promise<DedicatedSpeakerModule>;
  private readonly shouldSilence?: () => boolean;

  private engine?: OfflineTtsLike;
  private speakerModule?: DedicatedSpeakerModule;
  private activePlayback?: DedicatedPlayback;
  private prepareController?: AbortController;
  private engineLoading?: Promise<OfflineTtsLike>;

  private readonly accumulators = new Map<string, SentenceAccumulator>();
  private queue: QueueItem[] = [];
  private playing = false;
  private playbackGeneration = 0;
  private speakingRequestId?: string;
  private engineLoadFailed = false;

  constructor(
    config: TtsConfig,
    private readonly models: TtsModelManager,
    options: TtsRuntimeOptions = {},
  ) {
    super();
    this.config = config;
    this.threads = options.threads ?? 2;
    this.loadSherpa = options.loadSherpa ?? defaultLoadSherpa;
    this.loadSpeaker = options.loadSpeaker ?? defaultLoadSpeaker;
    this.shouldSilence = options.shouldSilence;
    this.state = {
      enabled: config.enabled,
      phase: "not-installed",
      message: "语音朗读模型尚未安装。",
      modelDirectory: models.displayedDirectory,
      updatedAt: Date.now(),
    };
  }

  get snapshot(): TtsState {
    return { ...this.state, progress: this.state.progress ? { ...this.state.progress } : undefined };
  }

  private publish(next: Partial<TtsState>): TtsState {
    this.state = { ...this.state, ...next, updatedAt: Date.now() };
    this.emit("state", this.snapshot);
    return this.snapshot;
  }

  updateConfig(config: TtsConfig): void {
    const modelDirectoryChanged = config.modelDirectory !== this.config.modelDirectory;
    const previousEnabled = this.config.enabled;
    this.config = config;
    if (modelDirectoryChanged) {
      this.models.setImportedDirectory(config.modelDirectory);
      this.dropEngine();
    }
    if (!config.enabled) {
      this.stopAll();
      this.publish({
        enabled: false,
        phase: "not-installed",
        message: "语音朗读已关闭。",
        speakingRequestId: undefined,
        error: undefined,
      });
    } else if (!previousEnabled) {
      this.publish({ enabled: true });
      void this.initializeAvailability();
    } else {
      this.publish({ enabled: true });
    }
  }

  private dropEngine(): void {
    this.playbackGeneration += 1;
    this.engine = undefined;
    this.engineLoadFailed = false;
    this.activePlayback?.stop();
    this.activePlayback = undefined;
  }

  async initializeAvailability(): Promise<TtsState> {
    if (!this.config.enabled) {
      return this.publish({ enabled: false, phase: "not-installed", message: "语音朗读已关闭。" });
    }
    if (!(await this.models.isReady())) {
      return this.publish({
        phase: "not-installed",
        message: this.config.modelDirectory
          ? "找不到已导入的 TTS 模型，请重新选择目录或自动下载。"
          : "请选择自动下载约 170 MB 语音朗读模型，或导入已有模型。",
        modelDirectory: this.models.displayedDirectory,
        error: undefined,
      });
    }
    return this.publish({
      phase: "ready",
      message: "语音朗读模型已就绪，团子可以用本地语音回答。",
      modelDirectory: this.models.displayedDirectory,
      error: undefined,
    });
  }

  async prepare(force = false): Promise<TtsState> {
    if (!this.config.enabled) throw new Error("请先在设置中启用语音朗读。");
    if (this.prepareController) return this.snapshot;
    this.models.useManagedModels();
    this.dropEngine();
    this.prepareController = new AbortController();
    this.publish({
      phase: "downloading",
      message: "正在下载本地语音朗读模型…",
      modelDirectory: this.models.displayedDirectory,
      error: undefined,
      progress: undefined,
    });
    try {
      await this.models.prepare(this.prepareController.signal, (progress) => {
        this.publish({
          phase: "downloading",
          message: "正在下载本地语音朗读模型…",
          progress,
        });
      }, force);
      this.publish({ phase: "loading", message: "正在加载本地语音朗读模型…", progress: undefined });
      await this.loadEngine();
      return this.publish({ phase: "ready", message: "语音朗读模型已就绪，可以试听或开始聊天。", error: undefined });
    } catch (error) {
      const text = message(error);
      this.publish({ phase: "error", message: "语音朗读模型准备失败。", error: text, progress: undefined });
      throw error;
    } finally {
      this.prepareController = undefined;
    }
  }

  async importFromDirectory(sourceDirectory: string): Promise<TtsState> {
    if (this.prepareController) throw new Error("语音朗读模型正在下载，请稍后再导入。");
    this.dropEngine();
    this.publish({ phase: "loading", message: "正在搜索并导入本地 TTS 模型…", error: undefined, progress: undefined });
    try {
      await this.models.importFromDirectory(sourceDirectory);
      if (!this.config.enabled) {
        return this.publish({
          phase: "not-installed",
          message: "已连接本地 TTS 模型；启用语音朗读后即可使用。",
          modelDirectory: this.models.displayedDirectory,
        });
      }
      await this.loadEngine();
      return this.publish({
        phase: "ready",
        message: "已连接本地 TTS 模型，团子可以用本地语音回答。",
        modelDirectory: this.models.displayedDirectory,
        error: undefined,
      });
    } catch (error) {
      const text = message(error);
      this.publish({ phase: "error", message: "本地 TTS 模型导入失败。", error: text });
      throw error;
    }
  }

  private engineConfig(): Record<string, unknown> {
    const paths = this.models.paths;
    // The melo model ships inverse-text-normalization rule FSTs: when present,
    // they make the engine read digits and dates aloud instead of skipping
    // them as out-of-vocabulary characters.
    const ruleFsts = ["date.fst", "phone.fst", "number.fst", "new_heteronym.fst"]
      .map((name) => join(paths.directory, name))
      .filter((file) => existsSync(file))
      .join(",");
    return {
      model: {
        vits: {
          model: paths.model,
          tokens: paths.tokens,
          lexicon: paths.lexicon,
          ...(paths.dataDir ? { dataDir: paths.dataDir } : {}),
          noiseScale: 0.667,
          noiseScaleW: 0.8,
          lengthScale: 1,
        },
        numThreads: this.threads,
        provider: "cpu",
        debug: false,
      },
      maxNumSentences: 2,
      ...(ruleFsts ? { ruleFsts } : {}),
    };
  }

  private async loadEngine(): Promise<OfflineTtsLike> {
    if (this.engine) return this.engine;
    if (this.engineLoadFailed) throw new Error("语音朗读引擎加载失败，请重新下载或导入 TTS 模型。");
    if (this.engineLoading) return this.engineLoading;
    this.engineLoading = (async () => {
      const generation = this.playbackGeneration;
      const sherpa = await this.loadSherpa();
      const engine = await sherpa.OfflineTts.createAsync(this.engineConfig());
      // The engine may have been dropped while this load was in flight.
      if (generation === this.playbackGeneration) {
        this.engine = engine;
      }
      return engine;
    })()
      .catch((error) => {
        this.engineLoadFailed = true;
        throw error;
      })
      .finally(() => {
        this.engineLoading = undefined;
      });
    return this.engineLoading;
  }

  private async openPlayback(sampleRate: number, generation: number): Promise<DedicatedPlayback> {
    this.speakerModule ??= await this.loadSpeaker();
    const speaker = await this.speakerModule.Speaker.open({
      sampleRate,
      channels: 1,
      dtype: "float32",
    });
    return new DedicatedPlayback({
      speaker,
      shouldStop: () => generation !== this.playbackGeneration,
    });
  }

  /**
   * Chat streaming hooks. Reasoning deltas are never spoken; only the reply
   * content (`delta`) is fed to the sentence accumulator.
   */
  onChatStart(requestId: string): void {
    this.interruptAll();
    this.accumulators.set(requestId, new SentenceAccumulator());
  }

  onChatEvent(event: ChatEvent): void {
    if (!this.config.enabled) return;
    if (event.type === "delta") {
      const accumulator = this.accumulators.get(event.requestId);
      if (!accumulator) return;
      for (const sentence of accumulator.feed(event.text)) this.enqueue(event.requestId, sentence);
      return;
    }
    if (event.type === "done" || event.type === "error") {
      const accumulator = this.accumulators.get(event.requestId);
      this.accumulators.delete(event.requestId);
      if (!accumulator) return;
      for (const sentence of accumulator.finish()) this.enqueue(event.requestId, sentence);
    }
  }

  private enqueue(requestId: string, text: string): void {
    // Keep a final safety boundary immediately before the native Melo addon.
    // Its zero-token failure path terminates the Electron process instead of
    // raising a recoverable JavaScript exception.
    const cleaned = cleanTtsText(text);
    if (!isSpeakableTtsText(cleaned) || this.engineLoadFailed) return;
    this.queue.push({ requestId, text: cleaned });
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.playing) return;
    this.playing = true;
    let failed = false;
    let playback: DedicatedPlayback | undefined;
    try {
      while (this.queue.length && this.config.enabled) {
        const generation = this.playbackGeneration;
        const engine = await this.loadEngine();
        if (generation !== this.playbackGeneration) break;
        const speakerId = Math.min(this.config.speaker, Math.max(0, engine.numSpeakers - 1));
        playback = await this.openPlayback(engine.sampleRate, generation);
        if (generation !== this.playbackGeneration) {
          playback.stop();
          break;
        }
        this.activePlayback = playback;
        const activePlayback = playback;

        // Pipeline: synthesized chunks are pushed to the single continuous
        // playback queue as they arrive, so each sentence starts sounding
        // while it is still being generated, and the next sentence's
        // synthesis runs while the current one plays out.
        while (this.queue.length && generation === this.playbackGeneration && this.config.enabled) {
          const item = this.queue.shift();
          if (!item) break;
          if (this.shouldSilence?.()) continue;
          const cancelled = await this.generateSentenceInto(
            engine,
            item,
            speakerId,
            generation,
            (chunk) => activePlayback.push(chunk),
          );
          if (cancelled || generation !== this.playbackGeneration) break;
        }
        if (generation !== this.playbackGeneration) break;
        await activePlayback.drain();
        if (activePlayback.underrunCount > REPORTABLE_UNDERRUN_SAMPLES) {
          console.warn(`TTS playback inserted ${activePlayback.underrunCount} silence samples after underruns.`);
        }
        if (generation !== this.playbackGeneration) break;
        activePlayback.stop();
        if (this.activePlayback === activePlayback) this.activePlayback = undefined;
      }
    } catch (error) {
      failed = true;
      this.queue = [];
      if (!(await this.models.isReady())) {
        // The user chatted without installing the TTS model: stay quiet and
        // keep the not-installed hint instead of surfacing a scary error.
        this.publish({
          phase: "not-installed",
          message: "语音朗读模型尚未安装，聊天将以文字显示。",
          error: undefined,
        });
      } else {
        console.warn("TTS playback failed:", error);
        this.publish({ phase: "error", message: "语音朗读播放失败。", error: message(error) });
      }
    } finally {
      playback?.stop();
      if (this.activePlayback === playback) this.activePlayback = undefined;
      this.playing = false;
      if (failed || !this.config.enabled) return;
      if (!this.queue.length) {
        this.publishIdleState();
      } else {
        // Items may have been enqueued while this pump was interrupted; keep draining.
        void this.pump();
      }
    }
  }

  /**
   * Synthesizes one sentence, handing each PCM chunk to `onChunk` as soon as
   * the engine produces it. Returns true when generation was cancelled.
   */
  private async generateSentenceInto(
    engine: OfflineTtsLike,
    item: QueueItem,
    speaker: number,
    generation: number,
    onChunk: (chunk: Float32Array) => void,
  ): Promise<boolean> {
    this.speakingRequestId = item.requestId;
    this.publish({ phase: "speaking", speakingRequestId: item.requestId, message: "团子正在说话…", error: undefined });

    let cancelled = false;
    let receivedChunks = false;
    const result = await engine.generateAsync({
      text: item.text,
      sid: speaker,
      speed: this.config.speed,
      // Electron's V8 disallows external ArrayBuffers ("External buffers
      // are not allowed"); copying the final samples is negligible and
      // keeps the addon on the plain-buffer path.
      enableExternalBuffer: false,
      onProgress: ({ samples }) => {
        if (generation !== this.playbackGeneration) {
          cancelled = true;
          return 0;
        }
        receivedChunks = true;
        onChunk(samples);
        return 1;
      },
    });
    if (cancelled || generation !== this.playbackGeneration) return true;
    // If synthesis never reported progress chunks, fall back to the full
    // buffer exactly once (the progress path already carries all samples).
    if (!receivedChunks && result.samples.length) onChunk(result.samples);
    return false;
  }

  interrupt(requestId: string): void {
    this.queue = this.queue.filter((item) => item.requestId !== requestId);
    this.accumulators.delete(requestId);
    if (this.speakingRequestId === requestId) {
      this.stopPlayback();
    }
  }

  interruptAll(): void {
    this.accumulators.clear();
    this.stopPlayback();
  }

  private stopPlayback(): void {
    this.playbackGeneration += 1;
    this.queue = [];
    this.activePlayback?.stop();
    this.activePlayback = undefined;
    this.publishIdleState();
  }

  /**
   * Returns the state to its idle phase after speaking stops, keeping the
   * phase/message pair consistent: "ready" once the engine is loaded, and the
   * previously published state otherwise (not-installed / error / …).
   */
  private publishIdleState(): void {
    if (!this.config.enabled) return;
    this.speakingRequestId = undefined;
    const phase = this.engine ? "ready" : this.state.phase === "speaking" ? "ready" : this.state.phase;
    this.publish({
      phase,
      speakingRequestId: undefined,
      error: undefined,
      ...(phase === "ready" ? { message: "语音朗读已就绪，团子会用本地语音回答。" } : {}),
    });
  }

  stopAll(): TtsState {
    this.interruptAll();
    return this.snapshot;
  }

  speakText(text: string): TtsState {
    if (!this.config.enabled) {
      this.publish({ enabled: false, phase: "not-installed", message: "语音朗读已关闭。" });
      return this.snapshot;
    }
    if (this.engineLoadFailed) {
      this.publish({ phase: "error", message: "语音朗读引擎加载失败，请重新下载或导入 TTS 模型。" });
      return this.snapshot;
    }
    this.interruptAll();
    const sentences = splitTtsSentences(text);
    if (!sentences.length) return this.snapshot;
    for (const sentence of sentences) this.enqueue(PREVIEW_REQUEST_ID, sentence);
    return this.snapshot;
  }

  async dispose(): Promise<void> {
    this.prepareController?.abort();
    this.interruptAll();
    this.removeAllListeners();
  }
}
