import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ChatEvent, TtsConfig, TtsDownloadProgress, TtsState } from "../shared/types";
import type { TtsModelManager } from "./tts-model-manager";
import { SentenceAccumulator, splitTtsSentences } from "./tts-text";

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
  LinearResampler: new (inputRate: number, outputRate: number) => LinearResamplerLike;
}

export interface LinearResamplerLike {
  resample(samples: Float32Array): Float32Array;
}

export interface CpalOutputDevice {
  deviceId: string;
  name: string;
}

export interface CpalOutputConfig {
  sampleRate: number;
  channels: number;
}

export type CpalOutputStream = unknown;

export interface CpalOutputModule {
  getDefaultOutputDevice(): CpalOutputDevice;
  getDefaultOutputConfig(deviceId: string): CpalOutputConfig;
  createStream(
    deviceId: string,
    input: boolean,
    config: CpalOutputConfig,
    onData: (samples: Float32Array) => void,
  ): CpalOutputStream;
  writeToStream(stream: CpalOutputStream, samples: Float32Array): void;
  closeStream(stream: CpalOutputStream): void;
}

export interface TtsRuntimeOptions {
  threads?: number;
  loadSherpa?: () => Promise<TtsSherpaModule>;
  loadCpal?: () => Promise<CpalOutputModule>;
  /** Called before each sentence starts playing; truthy means stay silent. */
  shouldSilence?: () => boolean;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultLoadSherpa(): Promise<TtsSherpaModule> {
  return Promise.resolve(require("sherpa-onnx-node") as TtsSherpaModule);
}

function defaultLoadCpal(): Promise<CpalOutputModule> {
  return Promise.resolve(require("node-cpal") as CpalOutputModule);
}

interface OpenedCpalOutput {
  device: CpalOutputDevice;
  config: CpalOutputConfig;
  stream: CpalOutputStream;
}

/**
 * Keeps the default output stream open between sentences so playback starts
 * without reopening the device. Re-queries the default device before use and
 * rebuilds the stream when it changes, mirroring WarmCpalInput for the mic.
 */
export class WarmCpalOutput {
  private current?: OpenedCpalOutput;

  constructor(private readonly cpal: CpalOutputModule) {}

  get output(): OpenedCpalOutput | undefined {
    return this.current;
  }

  ensureDefault(): OpenedCpalOutput {
    const device = this.cpal.getDefaultOutputDevice();
    if (this.current?.device.deviceId === device.deviceId) {
      this.current.device = device;
      return this.current;
    }

    const config = this.cpal.getDefaultOutputConfig(device.deviceId);
    const stream = this.cpal.createStream(device.deviceId, false, config, () => undefined);
    const previous = this.current;
    this.current = { device, config, stream };
    if (previous) {
      try {
        this.cpal.closeStream(previous.stream);
      } catch {
        // The old device may already have disappeared from the native backend.
      }
    }
    return this.current;
  }

  close(): void {
    const current = this.current;
    this.current = undefined;
    if (!current) return;
    try {
      this.cpal.closeStream(current.stream);
    } catch {
      // The stream may already have been closed by the native backend.
    }
  }
}

interface QueueItem {
  requestId: string;
  text: string;
}

const PREVIEW_REQUEST_ID = "preview";

interface PacedPlaybackOptions {
  cpal: CpalOutputModule;
  stream: CpalOutputStream;
  outputRate: number;
  deviceName: string;
  adapt: (samples: Float32Array) => Float32Array;
  shouldStop: () => boolean;
}

/**
 * Feeds PCM chunks to the output stream at real-time pace.
 *
 * The native output stream has a limited buffer: dumping synthesized audio as
 * fast as it is generated (usually faster than real time) overflows it and
 * the sound is dropped silently. This writer queues incoming chunks and
 * releases them according to the wall clock, so playback keeps exactly one
 * real-time schedule regardless of how fast synthesis produces samples.
 */
export class PacedPlayback {
  private chunks: Float32Array[] = [];
  private queued = 0;
  private written = 0;
  private startedAt = 0;
  private timer?: ReturnType<typeof setInterval>;
  private settle?: { resolve: () => void; reject: (error: Error) => void };
  private error?: Error;
  private disposed = false;

  constructor(private readonly options: PacedPlaybackOptions) {}

  get hasContent(): boolean {
    return this.queued > 0 || this.written > 0;
  }

  push(samples: Float32Array): void {
    if (this.disposed) return;
    const adapted = this.options.adapt(samples);
    if (!adapted.length) return;
    this.chunks.push(adapted);
    this.queued += adapted.length;
    this.start();
  }

  /** Resolves once every pushed sample has been handed to the stream. */
  drain(): Promise<void> {
    if (this.disposed) return this.error ? Promise.reject(this.error) : Promise.resolve();
    return new Promise((resolve, reject) => {
      this.settle = { resolve, reject };
      if (!this.chunks.length) {
        this.finish();
      } else {
        this.pump();
      }
    });
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.disposed = true;
    this.chunks = [];
    this.queued = 0;
    this.settle?.resolve();
    this.settle = undefined;
  }

  private start(): void {
    if (this.timer || this.disposed) return;
    this.startedAt = Date.now();
    this.timer = setInterval(() => this.pump(), 40);
  }

  private pump(): void {
    if (this.disposed) return;
    try {
      if (this.options.shouldStop() || this.error) {
        this.finish();
        return;
      }
      if (!this.chunks.length) return;
      const elapsedSamples = ((Date.now() - this.startedAt) / 1000) * this.options.outputRate;
      let allowed = Math.floor(elapsedSamples - this.written);
      while (allowed > 0 && this.chunks.length) {
        const chunk = this.chunks[0];
        if (!chunk) break;
        const take = Math.min(chunk.length, allowed);
        try {
          this.options.cpal.writeToStream(this.options.stream, chunk.subarray(0, take));
        } catch (error) {
          throw new Error(
            `播放设备写入失败（${this.options.deviceName}，${take} 采样）：${message(error)}`,
            { cause: error },
          );
        }
        this.written += take;
        this.queued -= take;
        allowed -= take;
        if (take >= chunk.length) this.chunks.shift();
        else this.chunks[0] = chunk.subarray(take);
      }
      if (!this.chunks.length && this.settle) this.finish();
    } catch (error) {
      this.error = error instanceof Error ? error : new Error(String(error));
      this.finish();
    }
  }

  private finish(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const settle = this.settle;
    this.settle = undefined;
    if (settle) {
      if (this.error) settle.reject(this.error);
      else settle.resolve();
    }
  }
}

export class TtsRuntime extends EventEmitter {
  private state: TtsState;
  private config: TtsConfig;
  private readonly threads: number;
  private readonly loadSherpa: () => Promise<TtsSherpaModule>;
  private readonly loadCpal: () => Promise<CpalOutputModule>;
  private readonly shouldSilence?: () => boolean;

  private sherpa?: TtsSherpaModule;
  private cpal?: CpalOutputModule;
  private engine?: OfflineTtsLike;
  private resampler?: LinearResamplerLike;
  private resamplerRate = 0;
  private output?: WarmCpalOutput;
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
    this.loadCpal = options.loadCpal ?? defaultLoadCpal;
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

  updateConfig(config: TtsConfig): void {    const modelDirectoryChanged = config.modelDirectory !== this.config.modelDirectory;
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
    this.resampler = undefined;
    this.resamplerRate = 0;
    this.output?.close();
    this.output = undefined;
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
        this.sherpa = sherpa;
        this.engine = engine;
        this.resampler = undefined;
        this.resamplerRate = 0;
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

  private async ensureCpal(): Promise<CpalOutputModule> {
    if (!this.cpal) {
      this.cpal = await this.loadCpal();
    }
    // The output wrapper is released whenever playback is interrupted, so
    // recreate it for every new playback session instead of only on load.
    this.output ??= new WarmCpalOutput(this.cpal);
    return this.cpal;
  }

  private async ensureOutput(
    engineRate: number,
  ): Promise<{ output: OpenedCpalOutput; resampler?: LinearResamplerLike; channels: number }> {
    await this.ensureCpal();
    const opened = this.output!.ensureDefault();
    if (opened.config.sampleRate !== engineRate) {
      if (!this.resampler || this.resamplerRate !== opened.config.sampleRate) {
        if (!this.sherpa) throw new Error("语音合成引擎尚未加载。");
        this.resampler = new this.sherpa.LinearResampler(engineRate, opened.config.sampleRate);
        this.resamplerRate = opened.config.sampleRate;
      }
    } else {
      this.resampler = undefined;
      this.resamplerRate = 0;
    }
    return { output: opened, resampler: this.resampler, channels: opened.config.channels };
  }

  private adaptToOutput(
    samples: Float32Array,
    resampler: LinearResamplerLike | undefined,
    channels: number,
  ): Float32Array {
    const mono = resampler ? resampler.resample(samples) : samples;
    if (channels <= 1 || !mono.length) return mono;
    const stereo = new Float32Array(mono.length * channels);
    for (let index = 0; index < mono.length; index += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        stereo[index * channels + channel] = mono[index] ?? 0;
      }
    }
    return stereo;
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
    const trimmed = text.trim();
    if (!trimmed || this.engineLoadFailed) return;
    this.queue.push({ requestId, text: trimmed });
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.playing) return;
    this.playing = true;
    let failed = false;
    try {
      while (this.queue.length && this.config.enabled) {
        const generation = this.playbackGeneration;
        const item = this.queue.shift();
        if (!item || generation !== this.playbackGeneration) break;
        if (!this.shouldSilence?.()) {
          await this.speakItem(item, generation);
        }
        if (generation !== this.playbackGeneration) break;
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

  private async speakItem(item: QueueItem, generation: number): Promise<void> {
    try {
      const engine = await this.loadEngine();
      if (generation !== this.playbackGeneration) return;
      const speaker = Math.min(this.config.speaker, Math.max(0, engine.numSpeakers - 1));
      this.speakingRequestId = item.requestId;
      this.publish({ phase: "speaking", speakingRequestId: item.requestId, message: "团子正在说话…", error: undefined });

      const { output, resampler, channels } = await this.ensureOutput(engine.sampleRate);
      if (generation !== this.playbackGeneration || !this.cpal) return;

      const playback = new PacedPlayback({
        cpal: this.cpal,
        stream: output.stream,
        outputRate: output.config.sampleRate,
        deviceName: output.device.name,
        adapt: (samples) => this.adaptToOutput(samples, resampler, channels),
        shouldStop: () => generation !== this.playbackGeneration,
      });

      let cancelled = false;
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
          playback.push(samples);
          return 1;
        },
      });
      if (cancelled || generation !== this.playbackGeneration) {
        playback.dispose();
        return;
      }
      // If synthesis never reported progress chunks, play the full buffer once.
      if (!playback.hasContent && result.samples.length) {
        playback.push(result.samples);
      }
      await playback.drain();
      if (generation !== this.playbackGeneration) return;
    } catch (error) {
      if (generation !== this.playbackGeneration) return;
      throw error;
    }
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
    // Closing the stream stops the current sound immediately.
    this.output?.close();
    this.output = undefined;
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
