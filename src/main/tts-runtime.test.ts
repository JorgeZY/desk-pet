import { describe, expect, it, vi } from "vitest";
import type { ChatEvent, TtsConfig, TtsState } from "../shared/types";
import type { TtsModelManager } from "./tts-model-manager";
import {
  DedicatedPlayback,
  type DedicatedSpeakerModule,
  type OfflineTtsLike,
  type TtsSherpaModule,
  TtsRuntime,
} from "./tts-runtime";

const config: TtsConfig = { enabled: true, speed: 1, speaker: 0, modelDirectory: "" };

const modelPaths = {
  root: "C:/models/speech",
  directory: "C:/models/speech/vits-melo-tts-zh_en",
  model: "C:/models/speech/vits-melo-tts-zh_en/model.onnx",
  lexicon: "C:/models/speech/vits-melo-tts-zh_en/lexicon.txt",
  tokens: "C:/models/speech/vits-melo-tts-zh_en/tokens.txt",
};

function fakeModels(): TtsModelManager {
  return {
    displayedDirectory: modelPaths.root,
    paths: modelPaths,
    isReady: vi.fn(async () => true),
    setImportedDirectory: vi.fn(),
    useManagedModels: vi.fn(),
    prepare: vi.fn(async () => modelPaths),
    importFromDirectory: vi.fn(async () => modelPaths),
  } as unknown as TtsModelManager;
}

function fakeEngine(delayMs = 0) {
  const generateAsync = vi.fn(
    async ({ text, onProgress }: { text: string; onProgress?: (info: { samples: Float32Array; progress: number }) => number | boolean | void }) => {
      const samples = new Float32Array([0.1, -0.1, 0.05]);
      onProgress?.({ samples, progress: 1 });
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { samples: new Float32Array(samples), sampleRate: 22050 };
    },
  );
  const engine: OfflineTtsLike = { sampleRate: 22050, numSpeakers: 3, generateAsync };
  return { engine, generateAsync };
}

function fakeSherpa(engine: OfflineTtsLike) {
  const createAsync = vi.fn(async () => engine);
  return {
    createAsync,
    module: {
      OfflineTts: { createAsync },
    } satisfies TtsSherpaModule,
  };
}

function fakeSpeaker() {
  const writeAsync = vi.fn(async (_chunk: Buffer) => undefined);
  const drainAsync = vi.fn(async () => undefined);
  const stop = vi.fn();
  const speaker = { writeAsync, drainAsync, stop, underrunCount: 0 };
  const open = vi.fn(async () => speaker);
  const module: DedicatedSpeakerModule = {
    Speaker: { open },
  };
  return { module, speaker, writeAsync, drainAsync, stop, open };
}

async function waitUntil(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!check() && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(check()).toBe(true);
}

function delta(requestId: string, text: string): ChatEvent {
  return { requestId, type: "delta", text };
}

describe("DedicatedPlayback", () => {
  it("primes cold output once, copies PCM chunks, and preserves write order", async () => {
    const { speaker, writeAsync, drainAsync } = fakeSpeaker();
    const playback = new DedicatedPlayback({ speaker, sampleRate: 1_000, shouldStop: () => false });
    const first = new Float32Array([0.1, -0.2]);
    const second = new Float32Array([0.3]);

    playback.push(first);
    playback.push(second);
    first.fill(0);
    await playback.drain();

    expect(writeAsync).toHaveBeenCalledTimes(2);
    const firstWritten = writeAsync.mock.calls[0]![0];
    const secondWritten = writeAsync.mock.calls[1]![0];
    const firstSamples = new Float32Array(
      firstWritten.buffer,
      firstWritten.byteOffset,
      firstWritten.byteLength / 4,
    );
    expect(firstSamples).toHaveLength(202);
    expect([...firstSamples.slice(0, 200)]).toEqual(Array.from({ length: 200 }, () => 0));
    expect([...firstSamples.slice(200)]).toEqual([expect.closeTo(0.1), expect.closeTo(-0.2)]);
    expect([...new Float32Array(secondWritten.buffer, secondWritten.byteOffset, secondWritten.byteLength / 4)]).toEqual([
      expect.closeTo(0.3),
    ]);
    expect(drainAsync).toHaveBeenCalledOnce();
  });

  it("stops native playback immediately", async () => {
    const { speaker, stop, writeAsync } = fakeSpeaker();
    const playback = new DedicatedPlayback({ speaker, sampleRate: 1_000, shouldStop: () => false });

    playback.stop();
    playback.push(new Float32Array([0.1]));
    await playback.drain();

    expect(stop).toHaveBeenCalledOnce();
    expect(writeAsync).not.toHaveBeenCalled();
  });
});

describe("TtsRuntime", () => {
  it("streams chat deltas into sentence playback and returns to ready", async () => {
    const { engine, generateAsync } = fakeEngine();
    const { createAsync, module } = fakeSherpa(engine);
    const { module: speakerModule, writeAsync, open } = fakeSpeaker();
    const runtime = new TtsRuntime(config, fakeModels(), {
      loadSherpa: async () => module,
      loadSpeaker: async () => speakerModule,
    });
    const states: TtsState[] = [];
    runtime.on("state", (state: TtsState) => states.push(state));

    await runtime.initializeAvailability();
    runtime.onChatStart("r1");
    runtime.onChatEvent(delta("r1", "你好。"));
    runtime.onChatEvent(delta("r1", "世界！"));
    runtime.onChatEvent({ requestId: "r1", type: "done" });

    await waitUntil(() => generateAsync.mock.calls.length === 2);
    await waitUntil(() =>
      states.some((state) => state.phase === "ready" && state.speakingRequestId === undefined),
    );

    expect(generateAsync.mock.calls.map((call) => call[0].text)).toEqual(["你好。", "世界！"]);
    // Electron's V8 throws "External buffers are not allowed" as an uncaught
    // exception when the addon hands back externally-backed ArrayBuffers.
    expect(generateAsync.mock.calls.every((call) => call[0].enableExternalBuffer === false)).toBe(true);
    expect(createAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({
          vits: expect.objectContaining({
            model: modelPaths.model,
            tokens: modelPaths.tokens,
            lexicon: modelPaths.lexicon,
          }),
          debug: false,
          numThreads: 2,
          provider: "cpu",
        }),
        maxNumSentences: 2,
      }),
    );
    expect(states.some((state) => state.phase === "speaking" && state.speakingRequestId === "r1")).toBe(true);
    expect(open).toHaveBeenCalledWith({ sampleRate: 22050, channels: 1, dtype: "float32" });
    expect(writeAsync).toHaveBeenCalled();
  });

  it("never sends an emoji-only streaming tail to the native engine", async () => {
    const { engine, generateAsync } = fakeEngine();
    const { module } = fakeSherpa(engine);
    const { module: speakerModule } = fakeSpeaker();
    const runtime = new TtsRuntime(config, fakeModels(), {
      loadSherpa: async () => module,
      loadSpeaker: async () => speakerModule,
    });

    await runtime.initializeAvailability();
    runtime.onChatStart("r1");
    runtime.onChatEvent(delta("r1", "今天也要把完成写在日历上哦！ 🍊✨"));
    runtime.onChatEvent({ requestId: "r1", type: "done" });

    await waitUntil(() => generateAsync.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(generateAsync.mock.calls.map((call) => call[0].text)).toEqual([
      "今天也要把完成写在日历上哦！",
    ]);
  });

  it("interrupts the current request and stops playback immediately", async () => {
    const { engine, generateAsync } = fakeEngine(60);
    const { module } = fakeSherpa(engine);
    const { module: speakerModule, stop } = fakeSpeaker();
    const runtime = new TtsRuntime(config, fakeModels(), {
      loadSherpa: async () => module,
      loadSpeaker: async () => speakerModule,
    });
    const states: TtsState[] = [];
    runtime.on("state", (state: TtsState) => states.push(state));

    await runtime.initializeAvailability();
    runtime.onChatStart("r1");
    runtime.onChatEvent(delta("r1", "第一句。"));

    await waitUntil(() => generateAsync.mock.calls.length === 1);

    runtime.interrupt("r1");
    runtime.onChatEvent(delta("r1", "第二句。"));

    await waitUntil(() =>
      states.some((state) => state.phase === "ready" && state.speakingRequestId === undefined),
    );
    expect(generateAsync).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalled();
  });

  it("starts a new request by discarding the previous queue", async () => {
    const { engine, generateAsync } = fakeEngine();
    const { module } = fakeSherpa(engine);
    const { module: speakerModule } = fakeSpeaker();
    const runtime = new TtsRuntime(config, fakeModels(), {
      loadSherpa: async () => module,
      loadSpeaker: async () => speakerModule,
    });

    await runtime.initializeAvailability();
    runtime.onChatStart("r1");
    runtime.onChatEvent(delta("r1", "旧回复。"));
    runtime.onChatStart("r2");
    runtime.onChatEvent(delta("r2", "新回复。"));
    runtime.onChatEvent({ requestId: "r2", type: "done" });

    await waitUntil(() => generateAsync.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(generateAsync.mock.calls.map((call) => call[0].text)).toEqual(["新回复。"]);
  });

  it("speaks preview text split into sentences in order", async () => {
    const { engine, generateAsync } = fakeEngine();
    const { module } = fakeSherpa(engine);
    const { module: speakerModule } = fakeSpeaker();
    const runtime = new TtsRuntime(config, fakeModels(), {
      loadSherpa: async () => module,
      loadSpeaker: async () => speakerModule,
    });

    await runtime.initializeAvailability();
    runtime.speakText("试听第一句。试听第二句。");

    await waitUntil(() => generateAsync.mock.calls.length === 2);
    expect(generateAsync.mock.calls.map((call) => call[0].text)).toEqual([
      "试听第一句。",
      "试听第二句。",
    ]);
  });

  it("stays silent while disabled", async () => {
    const { engine, generateAsync } = fakeEngine();
    const { module } = fakeSherpa(engine);
    const { module: speakerModule } = fakeSpeaker();
    const runtime = new TtsRuntime({ ...config, enabled: false }, fakeModels(), {
      loadSherpa: async () => module,
      loadSpeaker: async () => speakerModule,
    });

    runtime.onChatEvent(delta("r1", "你好。"));
    const state = runtime.speakText("你好。");

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(generateAsync).not.toHaveBeenCalled();
    expect(state.enabled).toBe(false);
    expect(state.phase).toBe("not-installed");
  });

  it("skips playback while the shouldSilence guard is active", async () => {
    const { engine, generateAsync } = fakeEngine();
    const { module } = fakeSherpa(engine);
    const { module: speakerModule } = fakeSpeaker();
    const runtime = new TtsRuntime(config, fakeModels(), {
      loadSherpa: async () => module,
      loadSpeaker: async () => speakerModule,
      shouldSilence: () => true,
    });

    await runtime.initializeAvailability();
    runtime.speakText("安静。");

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(generateAsync).not.toHaveBeenCalled();
  });

  it("clamps the speaker id to the model range", async () => {
    const { engine, generateAsync } = fakeEngine();
    const { module } = fakeSherpa(engine);
    const { module: speakerModule } = fakeSpeaker();
    const runtime = new TtsRuntime({ ...config, speaker: 99 }, fakeModels(), {
      loadSherpa: async () => module,
      loadSpeaker: async () => speakerModule,
    });

    await runtime.initializeAvailability();
    runtime.speakText("你好。");

    await waitUntil(() => generateAsync.mock.calls.length === 1);
    expect(generateAsync.mock.calls[0]?.[0].sid).toBe(2);
  });

  it("reopens the output stream after playback was stopped", async () => {
    const { engine, generateAsync } = fakeEngine();
    const { module } = fakeSherpa(engine);
    const firstSpeaker = fakeSpeaker();
    const secondSpeaker = fakeSpeaker();
    const open = vi.fn()
      .mockResolvedValueOnce(firstSpeaker.speaker)
      .mockResolvedValueOnce(secondSpeaker.speaker);
    const speakerModule: DedicatedSpeakerModule = { Speaker: { open } };
    const runtime = new TtsRuntime(config, fakeModels(), {
      loadSherpa: async () => module,
      loadSpeaker: async () => speakerModule,
    });

    await runtime.initializeAvailability();
    runtime.speakText("第一句。");
    await waitUntil(() => generateAsync.mock.calls.length === 1);

    runtime.stopAll();
    runtime.speakText("第二句。");
    await waitUntil(() => generateAsync.mock.calls.length === 2);

    expect(generateAsync.mock.calls.map((call) => call[0].text)).toEqual(["第一句。", "第二句。"]);
    expect(open).toHaveBeenCalledTimes(2);
  });
});
