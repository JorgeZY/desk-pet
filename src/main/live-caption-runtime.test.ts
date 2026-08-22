import { describe, expect, it, vi } from "vitest";
import { LiveCaptionRuntime } from "./live-caption-runtime";
import { InProcessLiveCaptionBackend, type LiveCaptionBackend } from "./live-caption-worker-backend";
import type { CaptionSherpaModule } from "./live-caption-worker-engine";
import type { SpeechModelManager } from "./speech-model-manager";

class FakeStream {
  samples = 0;
  text = "";
  acceptedSampleLengths: number[] = [];
  acceptWaveform(input: { samples: Float32Array }): void {
    this.acceptedSampleLengths.push(input.samples.length);
    this.samples += input.samples.length;
    this.text = "this is a live caption";
  }
  inputFinished(): void {}
}

function fakeSherpa(
  endpointSamples = Number.POSITIVE_INFINITY,
  configs: Record<string, unknown>[] = [],
  streams: FakeStream[] = [],
): CaptionSherpaModule {
  return {
    OnlineRecognizer: class {
      constructor(config: Record<string, unknown>) { configs.push(config); }
      createStream(): FakeStream {
        const stream = new FakeStream();
        streams.push(stream);
        return stream;
      }
      isReady(): boolean { return false; }
      decode(): void {}
      isEndpoint(stream: FakeStream): boolean { return stream.samples >= endpointSamples; }
      reset(stream: FakeStream): void { stream.samples = 0; stream.text = ""; }
      getResult(stream: FakeStream): { text: string } { return { text: stream.text }; }
    },
    LinearResampler: class {
      resample(samples: Float32Array): Float32Array { return samples; }
      flush(): Float32Array { return new Float32Array(); }
    },
  } as unknown as CaptionSherpaModule;
}

function fakeModels(ready = true): SpeechModelManager {
  return {
    captionPaths: {
      directory: "D:\\models\\speech\\streaming-nemotron-en",
      encoder: "encoder.int8.onnx",
      decoder: "decoder.int8.onnx",
      joiner: "joiner.int8.onnx",
      tokens: "tokens.txt",
      featureDim: 128,
    },
    isCaptionReady: vi.fn(async () => ready),
    prepareCaption: vi.fn(async () => undefined),
  } as unknown as SpeechModelManager;
}

class ControlledBackend implements LiveCaptionBackend {
  private onEvent?: Parameters<LiveCaptionBackend["start"]>[1];

  async start(
    _config: Parameters<LiveCaptionBackend["start"]>[0],
    onEvent: Parameters<LiveCaptionBackend["start"]>[1],
  ): Promise<void> {
    this.onEvent = onEvent;
    onEvent({ type: "ready" });
  }

  acceptAudio(): void {}

  async stop(): Promise<void> {
    this.onEvent?.({ type: "stopped" });
  }

  async terminate(): Promise<void> {}

  emit(event: Parameters<NonNullable<typeof this.onEvent>>[0]): void {
    this.onEvent?.(event);
  }
}
describe("LiveCaptionRuntime", () => {
  it("publishes partial text and commits a stable endpoint segment", async () => {
    const configs: Record<string, unknown>[] = [];
    const runtime = new LiveCaptionRuntime(2, fakeModels(), () =>
      new InProcessLiveCaptionBackend(() => fakeSherpa(32_000, configs)));
    await runtime.initializeAvailability();
    const started = await runtime.start();
    const sessionId = started.sessionId!;

    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      featConfig: { sampleRate: 16_000, featureDim: 128 },
      modelConfig: {
        transducer: {
          encoder: "encoder.int8.onnx",
          decoder: "decoder.int8.onnx",
          joiner: "joiner.int8.onnx",
        },
        tokens: "tokens.txt",
        numThreads: 2,
        provider: "cpu",
      },
      decodingMethod: "greedy_search",
      maxActivePaths: 4,
      blankPenalty: 0.5,
      enableEndpoint: true,
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: 1.2,
      rule3MinUtteranceLength: 300,
    });
    expect(configs[0].modelConfig).not.toHaveProperty("paraformer");

    runtime.acceptAudio(sessionId, 16_000, new Float32Array(16_000));
    expect(runtime.snapshot.partial).toBe("this is a live caption");
    runtime.acceptAudio(sessionId, 16_000, new Float32Array(16_000));

    expect(runtime.snapshot.partial).toBe("");
    expect(runtime.snapshot.segments).toHaveLength(1);
    expect(runtime.snapshot.segments[0]).toMatchObject({
      text: "this is a live caption",
      startMs: 0,
      endMs: 2000,
    });
  });

  it("does not cut a continuous utterance at twenty seconds", async () => {
    const runtime = new LiveCaptionRuntime(2, fakeModels(), () =>
      new InProcessLiveCaptionBackend(() => fakeSherpa()));
    const sessionId = (await runtime.start()).sessionId!;

    for (let index = 0; index < 20; index += 1) {
      runtime.acceptAudio(sessionId, 16_000, new Float32Array(16_000));
    }

    expect(runtime.snapshot.segments).toHaveLength(0);
    expect(runtime.snapshot.partial).toBe("this is a live caption");
  });

  it("ignores stale sessions and rejects a changed input sample rate", async () => {
    const runtime = new LiveCaptionRuntime(2, fakeModels(), () =>
      new InProcessLiveCaptionBackend(() => fakeSherpa()));
    const sessionId = (await runtime.start()).sessionId!;

    expect(runtime.acceptAudio("old-session", 16_000, new Float32Array(1600))).toBe(false);
    expect(runtime.snapshot.partial).toBe("");
    expect(runtime.acceptAudio(sessionId, 16_000, new Float32Array(1600))).toBe(true);
    expect(runtime.acceptAudio(sessionId, 48_000, new Float32Array(1600))).toBe(false);

    expect(runtime.snapshot.phase).toBe("error");
    expect(runtime.snapshot.error).toContain("采样率已变化");
  });

  it("commits the remaining partial on stop and clears session history", async () => {
    const streams: FakeStream[] = [];
    const runtime = new LiveCaptionRuntime(2, fakeModels(), () =>
      new InProcessLiveCaptionBackend(() => fakeSherpa(Infinity, [], streams)));
    const sessionId = (await runtime.start()).sessionId!;
    runtime.acceptAudio(sessionId, 16_000, new Float32Array(4000));

    const stopped = await runtime.stop();
    expect(stopped.phase).toBe("ready");
    expect(stopped.sessionId).toBeUndefined();
    expect(stopped.segments).toHaveLength(1);
    expect(stopped.segments[0].endMs).toBe(250);
    expect(streams[0].acceptedSampleLengths).toEqual([4000, 4800]);
    expect(runtime.clear().segments).toEqual([]);
  });

  it("finalizes the current English segment when the capture track ends", async () => {
    const runtime = new LiveCaptionRuntime(2, fakeModels(), () =>
      new InProcessLiveCaptionBackend(() => fakeSherpa()));
    const sessionId = (await runtime.start()).sessionId!;
    runtime.acceptAudio(sessionId, 16_000, new Float32Array(1600));

    const ended = runtime.captureEnded("The output device changed.");

    expect(ended.phase).toBe("error");
    expect(ended.sessionId).toBeUndefined();
    expect(ended.segments).toHaveLength(1);
    expect(ended.segments[0]).toMatchObject({
      text: "this is a live caption",
      startMs: 0,
      endMs: 100,
    });
  });

  it("requests setup without loading native code when the model is absent", async () => {
    const runtime = new LiveCaptionRuntime(2, fakeModels(false), () => {
      throw new Error("native code should not load");
    });
    const events: unknown[] = [];
    runtime.on("event", (event) => events.push(event));

    const state = await runtime.start();

    expect(state.phase).toBe("not-installed");
    expect(events).toContainEqual({ type: "setup-required" });
  });

  it("rebuilds the recognizer after the capped CPU thread count changes during capture", async () => {
    const configs: Record<string, unknown>[] = [];
    const runtime = new LiveCaptionRuntime(8, fakeModels(), () =>
      new InProcessLiveCaptionBackend(() => fakeSherpa(Infinity, configs)));
    await runtime.start();
    runtime.updateThreads(1);
    await runtime.stop();
    await runtime.start();
    runtime.updateThreads(6);
    await runtime.stop();
    await runtime.start();

    expect(configs).toHaveLength(3);
    expect(configs[0]).toMatchObject({ modelConfig: { numThreads: 2 } });
    expect(configs[1]).toMatchObject({ modelConfig: { numThreads: 1 } });
    expect(configs[2]).toMatchObject({ modelConfig: { numThreads: 2 } });
  });

  it("coalesces rapid partials while publishing final segments immediately", async () => {
    vi.useFakeTimers();
    try {
      const backend = new ControlledBackend();
      const runtime = new LiveCaptionRuntime(2, fakeModels(), () => backend);
      const sessionId = (await runtime.start()).sessionId!;

      backend.emit({ type: "partial", text: "one", startMs: 0, endMs: 50 });
      expect(runtime.snapshot.partial).toBe("one");
      backend.emit({ type: "partial", text: "two", startMs: 0, endMs: 80 });
      expect(runtime.snapshot.partial).toBe("one");

      await vi.advanceTimersByTimeAsync(119);
      expect(runtime.snapshot.partial).toBe("one");
      await vi.advanceTimersByTimeAsync(1);
      expect(runtime.snapshot.partial).toBe("two");

      backend.emit({ type: "partial", text: "three", startMs: 0, endMs: 110 });
      backend.emit({ type: "segment", text: "final now", startMs: 0, endMs: 120 });
      expect(runtime.snapshot.partial).toBe("");
      expect(runtime.snapshot.segments.at(-1)?.text).toBe("final now");

      await vi.advanceTimersByTimeAsync(120);
      expect(runtime.snapshot.partial).toBe("");
      expect(runtime.acceptAudio(sessionId, 16_000, new Float32Array(10))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
