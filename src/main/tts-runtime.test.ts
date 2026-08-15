import { describe, expect, it, vi } from "vitest";
import type { ChatEvent, TtsConfig, TtsState } from "../shared/types";
import type { TtsModelManager } from "./tts-model-manager";
import {
  WarmCpalOutput,
  type CpalOutputModule,
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
  dataDir: "C:/models/speech/espeak-ng-data",
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
      LinearResampler: class {
        resample(samples: Float32Array): Float32Array {
          return new Float32Array(samples);
        }
      },
    } satisfies TtsSherpaModule,
  };
}

function fakeCpal() {
  const writeToStream = vi.fn();
  const closeStream = vi.fn();
  const createStream = vi.fn((deviceId: string) => ({ deviceId }));
  const cpal: CpalOutputModule = {
    getDefaultOutputDevice: () => ({ deviceId: "speaker", name: "Test speaker" }),
    getDefaultOutputConfig: () => ({ sampleRate: 44100, channels: 2 }),
    createStream,
    writeToStream,
    closeStream,
  };
  return { cpal, writeToStream, closeStream, createStream };
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

describe("WarmCpalOutput", () => {
  it("keeps the default output stream open and rebuilds it after a device switch", () => {
    let device = { deviceId: "built-in", name: "Built-in speaker" };
    const cpal: CpalOutputModule = {
      getDefaultOutputDevice: () => device,
      getDefaultOutputConfig: vi.fn(() => ({ sampleRate: 44100, channels: 2 })),
      createStream: vi.fn((deviceId: string) => ({ deviceId })),
      writeToStream: vi.fn(),
      closeStream: vi.fn(),
    };
    const output = new WarmCpalOutput(cpal);

    expect(output.ensureDefault().device.deviceId).toBe("built-in");
    expect(output.ensureDefault().device.deviceId).toBe("built-in");
    expect(cpal.createStream).toHaveBeenCalledTimes(1);

    device = { deviceId: "headset", name: "USB headset" };
    expect(output.ensureDefault().device.deviceId).toBe("headset");
    expect(cpal.createStream).toHaveBeenCalledTimes(2);
    expect(cpal.closeStream).toHaveBeenCalledWith({ deviceId: "built-in" });

    output.close();
    expect(cpal.closeStream).toHaveBeenCalledTimes(2);
  });
});

describe("TtsRuntime", () => {
  it("streams chat deltas into sentence playback and returns to ready", async () => {
    const { engine, generateAsync } = fakeEngine();
    const { createAsync, module } = fakeSherpa(engine);
    const { cpal, writeToStream } = fakeCpal();
    const runtime = new TtsRuntime(config, fakeModels(), {
      loadSherpa: async () => module,
      loadCpal: async () => cpal,
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
    expect(createAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({
          vits: expect.objectContaining({
            model: modelPaths.model,
            tokens: modelPaths.tokens,
            lexicon: modelPaths.lexicon,
            dataDir: modelPaths.dataDir,
          }),
          debug: false,
          numThreads: 2,
          provider: "cpu",
        }),
        maxNumSentences: 2,
      }),
    );
    expect(states.some((state) => state.phase === "speaking" && state.speakingRequestId === "r1")).toBe(true);
    expect(writeToStream).toHaveBeenCalled();
  });

  it("interrupts the current request and stops playback immediately", async () => {
    const { engine, generateAsync } = fakeEngine(60);
    const { module } = fakeSherpa(engine);
    const { cpal, closeStream } = fakeCpal();
    const runtime = new TtsRuntime(config, fakeModels(), {
      loadSherpa: async () => module,
      loadCpal: async () => cpal,
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
    expect(closeStream).toHaveBeenCalled();
  });

  it("starts a new request by discarding the previous queue", async () => {
    const { engine, generateAsync } = fakeEngine();
    const { module } = fakeSherpa(engine);
    const { cpal } = fakeCpal();
    const runtime = new TtsRuntime(config, fakeModels(), {
      loadSherpa: async () => module,
      loadCpal: async () => cpal,
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
    const { cpal } = fakeCpal();
    const runtime = new TtsRuntime(config, fakeModels(), {
      loadSherpa: async () => module,
      loadCpal: async () => cpal,
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
    const { cpal } = fakeCpal();
    const runtime = new TtsRuntime({ ...config, enabled: false }, fakeModels(), {
      loadSherpa: async () => module,
      loadCpal: async () => cpal,
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
    const { cpal } = fakeCpal();
    const runtime = new TtsRuntime(config, fakeModels(), {
      loadSherpa: async () => module,
      loadCpal: async () => cpal,
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
    const { cpal } = fakeCpal();
    const runtime = new TtsRuntime({ ...config, speaker: 99 }, fakeModels(), {
      loadSherpa: async () => module,
      loadCpal: async () => cpal,
    });

    await runtime.initializeAvailability();
    runtime.speakText("你好。");

    await waitUntil(() => generateAsync.mock.calls.length === 1);
    expect(generateAsync.mock.calls[0]?.[0].sid).toBe(2);
  });

  it("reopens the output stream after playback was stopped", async () => {
    const { engine, generateAsync } = fakeEngine();
    const { module } = fakeSherpa(engine);
    const { cpal, createStream } = fakeCpal();
    const runtime = new TtsRuntime(config, fakeModels(), {
      loadSherpa: async () => module,
      loadCpal: async () => cpal,
    });

    await runtime.initializeAvailability();
    runtime.speakText("第一句。");
    await waitUntil(() => generateAsync.mock.calls.length === 1);

    runtime.stopAll();
    runtime.speakText("第二句。");
    await waitUntil(() => generateAsync.mock.calls.length === 2);

    expect(generateAsync.mock.calls.map((call) => call[0].text)).toEqual(["第一句。", "第二句。"]);
    expect(createStream).toHaveBeenCalledTimes(2);
  });
});
