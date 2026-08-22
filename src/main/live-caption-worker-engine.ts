import type {
  CaptionWorkerConfig,
  CaptionWorkerEvent,
} from "./live-caption-worker-protocol";

const TARGET_SAMPLE_RATE = 16_000;
const FINAL_PADDING_SAMPLES = Math.round(TARGET_SAMPLE_RATE * 0.3);

interface OnlineStream {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
  inputFinished(): void;
}

interface OnlineRecognizer {
  createStream(): OnlineStream;
  isReady(stream: OnlineStream): boolean;
  decode(stream: OnlineStream): void;
  isEndpoint(stream: OnlineStream): boolean;
  reset(stream: OnlineStream): void;
  getResult(stream: OnlineStream): { text: string };
}

interface LinearResampler {
  resample(samples: Float32Array): Float32Array;
  flush(samples: Float32Array): Float32Array;
}

export interface CaptionSherpaModule {
  OnlineRecognizer: new (config: Record<string, unknown>) => OnlineRecognizer;
  LinearResampler: new (inputRate: number, outputRate: number) => LinearResampler;
}

export class LiveCaptionWorkerEngine {
  private sherpa?: CaptionSherpaModule;
  private recognizer?: OnlineRecognizer;
  private stream?: OnlineStream;
  private resampler?: LinearResampler;
  private inputSampleRate?: number;
  private processedSamples = 0;
  private segmentStartSample = 0;
  private lastPartial = "";
  private stopped = false;

  constructor(
    private readonly emit: (event: CaptionWorkerEvent) => void,
    private readonly loadSherpa: () => CaptionSherpaModule = () =>
      require("sherpa-onnx-node") as CaptionSherpaModule,
  ) {}

  initialize(config: CaptionWorkerConfig): void {
    const sherpa = this.loadSherpa();
    this.sherpa = sherpa;
    this.recognizer = new sherpa.OnlineRecognizer({
      featConfig: { sampleRate: TARGET_SAMPLE_RATE, featureDim: config.featureDim },
      modelConfig: {
        transducer: {
          encoder: config.encoder,
          decoder: config.decoder,
          joiner: config.joiner,
        },
        tokens: config.tokens,
        numThreads: config.threads,
        provider: "cpu",
        debug: false,
      },
      decodingMethod: "greedy_search",
      maxActivePaths: 4,
      blankPenalty: 0.5,
      enableEndpoint: true,
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: 1.2,
      rule3MinUtteranceLength: 300,
    });
    this.stream = this.recognizer.createStream();
    this.emit({ type: "ready" });
  }

  acceptAudio(inputSampleRate: number, samples: Float32Array): void {
    if (this.stopped || !this.recognizer || !this.stream) return;
    if (!this.resampler) {
      if (!this.sherpa) throw new Error("实时字幕识别器尚未初始化。");
      this.inputSampleRate = inputSampleRate;
      this.resampler = new this.sherpa.LinearResampler(inputSampleRate, TARGET_SAMPLE_RATE);
    }
    const resampled = this.resampler.resample(samples);
    if (resampled.length) this.acceptResampled(resampled);
  }

  private acceptResampled(samples: Float32Array): void {
    if (!this.recognizer || !this.stream) return;
    this.processedSamples += samples.length;
    this.stream.acceptWaveform({ sampleRate: TARGET_SAMPLE_RATE, samples });
    while (this.recognizer.isReady(this.stream)) this.recognizer.decode(this.stream);
    const text = this.recognizer.getResult(this.stream).text.trim();
    if (text !== this.lastPartial) {
      this.lastPartial = text;
      this.emit({
        type: "partial",
        text,
        startMs: this.sampleToMs(this.segmentStartSample),
        endMs: this.sampleToMs(this.processedSamples),
      });
    }
    if (this.recognizer.isEndpoint(this.stream)) {
      this.commitSegment(text);
      this.recognizer.reset(this.stream);
      this.segmentStartSample = this.processedSamples;
      this.lastPartial = "";
    }
  }

  private commitSegment(candidate?: string): void {
    if (!this.recognizer || !this.stream) return;
    const text = (candidate ?? this.recognizer.getResult(this.stream).text).trim();
    this.emit({
      type: "segment",
      text,
      startMs: this.sampleToMs(this.segmentStartSample),
      endMs: this.sampleToMs(this.processedSamples),
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.recognizer && this.stream) {
      const tail = this.resampler?.flush(new Float32Array()) ?? new Float32Array();
      if (tail.length) this.acceptResampled(tail);
      this.stream.acceptWaveform({
        sampleRate: TARGET_SAMPLE_RATE,
        samples: new Float32Array(FINAL_PADDING_SAMPLES),
      });
      this.stream.inputFinished();
      while (this.recognizer.isReady(this.stream)) this.recognizer.decode(this.stream);
      this.commitSegment();
    }
    this.emit({ type: "stopped" });
  }

  private sampleToMs(sample: number): number {
    return Math.round(sample * 1000 / TARGET_SAMPLE_RATE);
  }
}
