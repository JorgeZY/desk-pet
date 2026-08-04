import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  SpeechConfig,
  SpeechEvent,
  SpeechSessionSource,
  SpeechStartResult,
  SpeechState,
} from "../shared/types";
import { SpeechModelManager } from "./speech-model-manager";

interface OnlineStream {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
  inputFinished(): void;
}

interface OnlineRecognizer {
  createStream(): OnlineStream;
  isReady(stream: OnlineStream): boolean;
  decode(stream: OnlineStream): void;
  getResult(stream: OnlineStream): { text: string };
}

interface OfflineStream {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
}

interface OfflineRecognizer {
  createStream(): OfflineStream;
  decodeAsync(stream: OfflineStream): Promise<{ text: string }>;
}

interface LinearResampler {
  resample(samples: Float32Array): Float32Array;
  flush(samples: Float32Array): Float32Array;
}

interface SherpaModule {
  OnlineRecognizer: new (config: Record<string, unknown>) => OnlineRecognizer;
  OfflineRecognizer: new (config: Record<string, unknown>) => OfflineRecognizer;
  LinearResampler: new (inputRate: number, outputRate: number) => LinearResampler;
}

export interface CpalDevice {
  deviceId: string;
  name: string;
}

export interface CpalInputConfig {
  sampleRate: number;
}

type CpalStream = unknown;

export interface CpalModuleLike {
  getDefaultInputDevice(): CpalDevice;
  getDefaultInputConfig(deviceId: string): CpalInputConfig;
  createStream(
    deviceId: string,
    input: boolean,
    config: { sampleRate: number; channels: number; format: "f32" },
    onData: (samples: Float32Array) => void,
  ): CpalStream;
  closeStream(stream: CpalStream): void;
}

export function createCpalInputStream(
  cpal: CpalModuleLike,
  deviceId: string,
  sampleRate: number,
  onData: (samples: Float32Array) => void,
): CpalStream {
  return cpal.createStream(
    deviceId,
    true,
    { sampleRate, channels: 1, format: "f32" },
    onData,
  );
}

export function warmCpalInput(
  cpal: CpalModuleLike,
  deviceId: string,
  sampleRate: number,
): void {
  const stream = createCpalInputStream(cpal, deviceId, sampleRate, () => undefined);
  cpal.closeStream(stream);
}

export interface OpenedCpalInput {
  device: CpalDevice;
  config: CpalInputConfig;
  stream: CpalStream;
}

export function openDefaultCpalInput(
  cpal: CpalModuleLike,
  onData: (samples: Float32Array) => void,
): OpenedCpalInput {
  const open = (): OpenedCpalInput => {
    const device = cpal.getDefaultInputDevice();
    const config = cpal.getDefaultInputConfig(device.deviceId);
    return {
      device,
      config,
      stream: createCpalInputStream(cpal, device.deviceId, config.sampleRate, onData),
    };
  };

  try {
    return open();
  } catch {
    return open();
  }
}

interface ActiveSpeechSession {
  id: string;
  source: SpeechSessionSource;
  chunks: Float32Array[];
  recording: boolean;
  stream: CpalStream;
  resampler: LinearResampler;
  onlineStream: OnlineStream;
  lastPartial: string;
  lastMeterAt: number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function joinSamples(chunks: readonly Float32Array[]): Float32Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function validTranscript(text: string): boolean {
  return text.length >= 2 && /[\p{L}\p{N}]/u.test(text);
}

export class SpeechRuntime extends EventEmitter {
  private state: SpeechState;
  private config: SpeechConfig;
  private sherpa?: SherpaModule;
  private cpal?: CpalModuleLike;
  private onlineRecognizer?: OnlineRecognizer;
  private offlineRecognizer?: OfflineRecognizer;
  private active?: ActiveSpeechSession;
  private prepareController?: AbortController;
  private microphoneWarmup?: Promise<void>;
  private microphoneWarmed = false;

  constructor(
    config: SpeechConfig,
    private readonly models: SpeechModelManager,
  ) {
    super();
    this.config = config;
    this.state = {
      enabled: config.enabled,
      phase: "not-installed",
      message: "语音模型尚未安装。",
      modelDirectory: models.displayedDirectory,
      updatedAt: Date.now(),
    };
  }

  get snapshot(): SpeechState {
    return { ...this.state, progress: this.state.progress ? { ...this.state.progress } : undefined };
  }

  private publish(next: Partial<SpeechState>): SpeechState {
    this.state = { ...this.state, ...next, updatedAt: Date.now() };
    this.emit("state", this.snapshot);
    return this.snapshot;
  }

  private publishEvent(event: SpeechEvent): void {
    this.emit("event", event);
  }

  updateConfig(config: SpeechConfig): void {
    const wasEnabled = this.config.enabled;
    const reload = config.threads !== this.config.threads || config.language !== this.config.language;
    const modelDirectoryChanged = config.modelDirectory !== this.config.modelDirectory;
    this.config = config;
    if (modelDirectoryChanged) this.models.setImportedDirectory(config.modelDirectory);
    if ((reload || modelDirectoryChanged) && !this.active) {
      this.onlineRecognizer = undefined;
      this.offlineRecognizer = undefined;
    }
    if (!config.enabled) {
      if (this.active) void this.cancel(this.active.id);
      this.publish({ enabled: false, phase: "not-installed", message: "语音输入已关闭。", error: undefined });
    } else if (!wasEnabled) {
      this.publish({ enabled: true });
      void this.initializeAvailability();
    } else {
      this.publish({ enabled: true });
    }
  }

  async initializeAvailability(): Promise<SpeechState> {
    if (!this.config.enabled) {
      return this.publish({ enabled: false, phase: "not-installed", message: "语音输入已关闭。" });
    }
    if (!(await this.models.isReady())) {
      return this.publish({
        phase: "not-installed",
        message: this.config.modelDirectory
          ? "找不到已导入的语音模型，请重新选择目录或自动下载。"
          : "请选择自动下载约 450 MB 语音模型，或导入已有模型。",
        modelDirectory: this.models.displayedDirectory,
      });
    }
    try {
      await this.loadRecognizers();
      return this.snapshot;
    } catch (error) {
      return this.publish({ phase: "error", message: "语音运行时加载失败。", error: message(error) });
    }
  }

  async prepare(force = false): Promise<SpeechState> {
    if (!this.config.enabled) throw new Error("请先在设置中启用语音输入。");
    if (this.prepareController) return this.snapshot;
    this.models.useManagedModels();
    this.prepareController = new AbortController();
    this.publish({
      phase: "downloading",
      message: "正在下载本地语音模型…",
      modelDirectory: this.models.displayedDirectory,
      error: undefined,
    });
    try {
      if (force) {
        this.onlineRecognizer = undefined;
        this.offlineRecognizer = undefined;
      }
      await this.models.prepare(this.prepareController.signal, (progress) => {
        this.publish({
          phase: "downloading",
          message: progress.model === "streaming-paraformer" ? "正在下载实时转写模型…" : "正在下载最终识别模型…",
          progress,
        });
      }, force);
      this.publish({ phase: "loading", message: "正在加载本地语音模型…", progress: undefined });
      await this.loadRecognizers();
      return this.snapshot;
    } catch (error) {
      const text = message(error);
      this.publish({ phase: "error", message: "语音模型准备失败。", error: text, progress: undefined });
      throw error;
    } finally {
      this.prepareController = undefined;
    }
  }

  async importFromDirectory(sourceDirectory: string): Promise<SpeechState> {
    if (this.active) throw new Error("请先结束当前录音，再导入语音模型。");
    if (this.prepareController) throw new Error("语音模型正在下载，请稍后再导入。");
    this.onlineRecognizer = undefined;
    this.offlineRecognizer = undefined;
    this.publish({ phase: "loading", message: "正在搜索并导入本地语音模型…", error: undefined, progress: undefined });
    try {
      await this.models.importFromDirectory(sourceDirectory);
      if (!this.config.enabled) {
        return this.publish({
          phase: "not-installed",
          message: "已连接本地语音模型；启用语音后即可使用。",
          modelDirectory: this.models.displayedDirectory,
        });
      }
      await this.loadRecognizers();
      return this.publish({
        phase: "ready",
        message: "已连接本地语音模型，可以开始说话。",
        modelDirectory: this.models.displayedDirectory,
      });
    } catch (error) {
      const text = message(error);
      this.publish({ phase: "error", message: "本地语音模型导入失败。", error: text });
      throw error;
    }
  }

  private async loadRecognizers(): Promise<void> {
    if (this.onlineRecognizer && this.offlineRecognizer && this.cpal && this.sherpa) {
      this.publish({ phase: "ready", message: "按住麦克风或 F8 开始说话。", error: undefined });
      void this.ensureMicrophoneWarm().catch(() => undefined);
      return;
    }
    this.publish({ phase: "loading", message: "正在加载本地语音模型…", error: undefined });
    const sherpa = require("sherpa-onnx-node") as SherpaModule;
    const cpal = require("node-cpal") as CpalModuleLike;
    const paths = this.models.paths;
    this.onlineRecognizer = new sherpa.OnlineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        paraformer: { encoder: paths.streaming.encoder, decoder: paths.streaming.decoder },
        tokens: paths.streaming.tokens,
        numThreads: this.config.threads,
        provider: "cpu",
        debug: false,
      },
      decodingMethod: "greedy_search",
      enableEndpoint: false,
    });
    this.offlineRecognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        senseVoice: {
          model: paths.final.model,
          language: this.config.language,
          useInverseTextNormalization: 1,
        },
        tokens: paths.final.tokens,
        numThreads: this.config.threads,
        provider: "cpu",
        debug: false,
      },
    });
    this.sherpa = sherpa;
    this.cpal = cpal;
    this.publish({ phase: "ready", message: "按住麦克风或 F8 开始说话。", error: undefined });
    void this.ensureMicrophoneWarm().catch((error) => {
      console.warn("Could not prewarm the default microphone:", error);
    });
  }

  private ensureMicrophoneWarm(): Promise<void> {
    if (this.microphoneWarmed) return Promise.resolve();
    if (this.microphoneWarmup) return this.microphoneWarmup;
    if (!this.cpal) return Promise.reject(new Error("麦克风运行时尚未加载。"));
    const cpal = this.cpal;
    const warmup = Promise.resolve().then(() => {
      const device = cpal.getDefaultInputDevice();
      const config = cpal.getDefaultInputConfig(device.deviceId);
      warmCpalInput(cpal, device.deviceId, config.sampleRate);
      this.microphoneWarmed = true;
    });
    this.microphoneWarmup = warmup.finally(() => {
      this.microphoneWarmup = undefined;
    });
    return this.microphoneWarmup;
  }

  requestSetup(): void {
    this.publishEvent({ type: "setup-required" });
  }

  async start(source: SpeechSessionSource): Promise<SpeechStartResult | null> {
    if (!this.config.enabled) return null;
    if (this.active) return { sessionId: this.active.id };
    if (!(await this.models.isReady())) {
      this.requestSetup();
      return null;
    }
    try {
      await this.loadRecognizers();
      if (!this.cpal || !this.sherpa || !this.onlineRecognizer) throw new Error("语音运行时尚未加载。");
      await this.ensureMicrophoneWarm();
      const sessionId = randomUUID();
      const onlineStream = this.onlineRecognizer.createStream();
      const openedInput = openDefaultCpalInput(
        this.cpal,
        (samples) => this.acceptSamples(sessionId, samples),
      );
      const { device, config: nativeConfig, stream } = openedInput;
      try {
        this.active = {
          id: sessionId,
          source,
          chunks: [],
          recording: true,
          stream,
          resampler: new this.sherpa.LinearResampler(nativeConfig.sampleRate, 16000),
          onlineStream,
          lastPartial: "",
          lastMeterAt: 0,
        };
      } catch (error) {
        this.cpal.closeStream(stream);
        throw error;
      }
      this.publish({
        phase: "recording",
        message: "正在听你说话…",
        inputDevice: device.name,
        activeSessionId: sessionId,
        level: 0,
        error: undefined,
      });
      this.publishEvent({ type: "started", sessionId, source });
      return { sessionId };
    } catch (error) {
      const text = message(error);
      this.publish({ phase: "error", message: "无法开始录音。", error: text, activeSessionId: undefined });
      this.publishEvent({ type: "error", message: text });
      throw error;
    }
  }

  private acceptSamples(sessionId: string, samples: Float32Array): void {
    const session = this.active;
    if (!session || !session.recording || session.id !== sessionId || !this.onlineRecognizer) return;
    try {
      const resampled = session.resampler.resample(samples);
      if (!resampled.length) return;
      session.chunks.push(resampled);
      session.onlineStream.acceptWaveform({ sampleRate: 16000, samples: resampled });
      while (this.onlineRecognizer.isReady(session.onlineStream)) {
        this.onlineRecognizer.decode(session.onlineStream);
      }
      const partial = this.onlineRecognizer.getResult(session.onlineStream).text.trim();
      if (partial && partial !== session.lastPartial) {
        session.lastPartial = partial;
        this.publishEvent({ type: "partial", sessionId, text: partial });
      }
      const now = Date.now();
      if (now - session.lastMeterAt >= 50) {
        let energy = 0;
        for (const sample of resampled) energy += sample * sample;
        session.lastMeterAt = now;
        this.publish({ level: Math.min(1, Math.sqrt(energy / resampled.length) * 6) });
      }
    } catch (error) {
      void this.failActive(error);
    }
  }

  async stop(sessionId: string): Promise<SpeechState> {
    const session = this.active;
    if (!session || session.id !== sessionId || !session.recording) return this.snapshot;
    await new Promise((resolve) => setTimeout(resolve, 120));
    session.recording = false;
    const tail = session.resampler.flush(new Float32Array());
    if (tail.length) session.chunks.push(tail);
    this.closeStream(session);
    this.active = undefined;
    const samples = joinSamples(session.chunks);
    if (samples.length / 16000 < 0.3) {
      this.publishEvent({ type: "cancelled", sessionId, message: "录音太短，已取消。" });
      return this.publish({ phase: "ready", message: "录音太短，按住后再说久一点。", activeSessionId: undefined, level: 0 });
    }

    this.publish({ phase: "transcribing", message: "正在把语音转成文字…", activeSessionId: sessionId, level: 0 });
    try {
      if (!this.offlineRecognizer) throw new Error("最终识别模型尚未加载。");
      const stream = this.offlineRecognizer.createStream();
      stream.acceptWaveform({ sampleRate: 16000, samples });
      const result = await this.offlineRecognizer.decodeAsync(stream);
      const text = result.text.trim();
      if (!validTranscript(text)) {
        this.publishEvent({ type: "cancelled", sessionId, message: "没有识别到清晰语音。" });
        return this.publish({ phase: "ready", message: "没有听清，再试一次吧。", activeSessionId: undefined });
      }
      this.publishEvent({ type: "final", sessionId, text });
      return this.publish({ phase: "ready", message: "转写完成，检查后即可发送。", activeSessionId: undefined });
    } catch (error) {
      const text = message(error);
      this.publishEvent({ type: "error", sessionId, message: text });
      this.publish({ phase: "error", message: "语音转换失败。", error: text, activeSessionId: undefined });
      throw error;
    }
  }

  async cancel(sessionId: string): Promise<SpeechState> {
    const session = this.active;
    if (!session || session.id !== sessionId) return this.snapshot;
    session.recording = false;
    this.closeStream(session);
    this.active = undefined;
    this.publishEvent({ type: "cancelled", sessionId, message: "录音已取消。" });
    return this.publish({ phase: "ready", message: "录音已取消。", activeSessionId: undefined, level: 0 });
  }

  private closeStream(session: ActiveSpeechSession): void {
    try {
      this.cpal?.closeStream(session.stream);
    } catch {
      // The stream may already have been closed by the native backend.
    }
  }

  private async failActive(error: unknown): Promise<void> {
    const session = this.active;
    if (!session) return;
    session.recording = false;
    this.closeStream(session);
    this.active = undefined;
    const text = message(error);
    this.publishEvent({ type: "error", sessionId: session.id, message: text });
    this.publish({ phase: "error", message: "麦克风读取失败。", error: text, activeSessionId: undefined, level: 0 });
  }

  async dispose(): Promise<void> {
    this.prepareController?.abort();
    if (this.active) await this.cancel(this.active.id);
    this.removeAllListeners();
  }
}
