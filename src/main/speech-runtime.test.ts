import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  createCpalInputStream,
  openDefaultCpalInput,
  SpeechRuntime,
  warmCpalInput,
  type CpalModuleLike,
  type SherpaModule,
} from "./speech-runtime";
import { resolveSpeechModelPaths, SpeechModelManager } from "./speech-model-manager";
import type { SpeechConfig } from "../shared/types";

const temporaryDirectories: string[] = [];
const testRoot = join(process.cwd(), ".test-tmp", "speech-runtime-latency");

async function makeReadyModels(): Promise<SpeechModelManager> {
  await fs.mkdir(testRoot, { recursive: true });
  const directory = await fs.mkdtemp(join(testRoot, "desk-pet-"));
  temporaryDirectories.push(directory);
  const paths = resolveSpeechModelPaths(directory);
  await fs.mkdir(paths.streaming.directory, { recursive: true });
  await fs.mkdir(paths.final.directory, { recursive: true });
  await Promise.all([
    fs.writeFile(paths.streaming.encoder, "encoder"),
    fs.writeFile(paths.streaming.decoder, "decoder"),
    fs.writeFile(paths.streaming.tokens, "tokens"),
    fs.writeFile(paths.final.model, "model"),
    fs.writeFile(paths.final.tokens, "tokens"),
  ]);
  return new SpeechModelManager(directory, join(directory, "scripts"), async () => undefined);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("node-cpal compatibility", () => {
  it("uses the createStream API exposed by the 0.1.1 native binary", () => {
    const handle = { streamId: "test" };
    const createStream = vi.fn(() => handle);
    const cpal: CpalModuleLike = {
      getDefaultInputDevice: () => ({ deviceId: "mic", name: "Test mic" }),
      getDefaultInputConfig: () => ({ sampleRate: 48000 }),
      createStream,
      closeStream: () => undefined,
    };
    const onData = vi.fn();

    expect(createCpalInputStream(cpal, "mic", 48000, onData)).toBe(handle);
    expect(createStream).toHaveBeenCalledWith(
      "mic",
      true,
      { sampleRate: 48000, channels: 1, format: "f32" },
      onData,
    );
  });

  it("opens and immediately closes a microphone stream during prewarm", () => {
    const handle = { streamId: "warmup" };
    const createStream = vi.fn(() => handle);
    const closeStream = vi.fn();
    const cpal: CpalModuleLike = {
      getDefaultInputDevice: () => ({ deviceId: "mic", name: "Test mic" }),
      getDefaultInputConfig: () => ({ sampleRate: 48000 }),
      createStream,
      closeStream,
    };

    warmCpalInput(cpal, "mic", 48000);

    expect(createStream).toHaveBeenCalledOnce();
    expect(closeStream).toHaveBeenCalledWith(handle);
  });

  it("re-queries the default microphone for every recording", () => {
    let currentDevice = { deviceId: "built-in", name: "Built-in mic" };
    const createStream = vi.fn((deviceId: string) => ({ deviceId }));
    const cpal: CpalModuleLike = {
      getDefaultInputDevice: vi.fn(() => currentDevice),
      getDefaultInputConfig: vi.fn(() => ({ sampleRate: 48000 })),
      createStream,
      closeStream: () => undefined,
    };

    expect(openDefaultCpalInput(cpal, vi.fn()).device.deviceId).toBe("built-in");
    currentDevice = { deviceId: "headset", name: "USB headset" };
    expect(openDefaultCpalInput(cpal, vi.fn()).device.deviceId).toBe("headset");
    expect(createStream.mock.calls.map(([deviceId]) => deviceId)).toEqual(["built-in", "headset"]);
  });

  it("refreshes the default microphone and retries once when opening fails", () => {
    const devices = [
      { deviceId: "disconnected", name: "Disconnected mic" },
      { deviceId: "headset", name: "USB headset" },
    ];
    const getDefaultInputDevice = vi.fn(() => devices.shift() ?? devices[0]);
    const createStream = vi.fn((deviceId: string) => {
      if (deviceId === "disconnected") throw new Error("device unavailable");
      return { deviceId };
    });
    const cpal: CpalModuleLike = {
      getDefaultInputDevice,
      getDefaultInputConfig: vi.fn(() => ({ sampleRate: 48000 })),
      createStream,
      closeStream: () => undefined,
    };

    const result = openDefaultCpalInput(cpal, vi.fn());

    expect(result.device.deviceId).toBe("headset");
    expect(getDefaultInputDevice).toHaveBeenCalledTimes(2);
    expect(createStream).toHaveBeenCalledTimes(2);
  });
});

describe("SpeechRuntime.start() latency", () => {
  function makeConfig(): SpeechConfig {
    return {
      enabled: true,
      globalShortcut: true,
      shortcut: "F8",
      threads: 1,
      language: "auto",
      modelDirectory: "",
    };
  }

  function makeSherpa(): { sherpa: SherpaModule; onlineStream: object; resampler: object } {
    const onlineStream = {
      acceptWaveform: () => undefined,
      inputFinished: () => undefined,
    };
    const resampler = {
      resample: (samples: Float32Array) => samples,
      flush: (samples: Float32Array) => samples,
    };
    const onlineRecognizer = {
      createStream: vi.fn(() => onlineStream),
      isReady: () => false,
      decode: () => undefined,
      getResult: () => ({ text: "" }),
    };
    const offlineRecognizer = {
      createStream: vi.fn(() => ({ acceptWaveform: () => undefined })),
      decodeAsync: async () => ({ text: "" }),
    };
    const sherpa = {
      OnlineRecognizer: vi.fn(() => onlineRecognizer),
      OfflineRecognizer: vi.fn(() => offlineRecognizer),
      LinearResampler: vi.fn(() => resampler),
    } as unknown as SherpaModule;
    return { sherpa, onlineStream, resampler };
  }

  function makeCpal(blockMs: number): { cpal: CpalModuleLike; openedAt: { ms: number }; resolvedAt: { ms: number } } {
    const openedAt = { ms: 0 };
    const resolvedAt = { ms: 0 };
    const cpal: CpalModuleLike = {
      getDefaultInputDevice: vi.fn(() => ({ deviceId: "slow-mic", name: "Slow mic" })),
      getDefaultInputConfig: vi.fn(() => ({ sampleRate: 48000 })),
      createStream: vi.fn((_deviceId, _isInput, _config, _onData) => {
        openedAt.ms = Date.now();
        const handle = { streamId: "slow-stream" };
        if (blockMs <= 0) {
          resolvedAt.ms = Date.now();
          return handle;
        }
        const start = Date.now();
        while (Date.now() - start < blockMs) {
          // Busy-wait to keep the test deterministic without fake timers.
        }
        resolvedAt.ms = Date.now();
        return handle;
      }),
      closeStream: () => undefined,
    };
    return { cpal, openedAt, resolvedAt };
  }

  it("emits the 'started' event before cpal createStream finishes on slow hardware", async () => {
    const { sherpa } = makeSherpa();
    const { cpal, openedAt, resolvedAt } = makeCpal(500);
    const models = await makeReadyModels();
    const runtime = new SpeechRuntime(makeConfig(), models, { sherpa, cpal });

    const events: { type: string; at: number }[] = [];
    runtime.on("event", (event) => {
      events.push({ type: event.type, at: Date.now() });
    });
    runtime.on("state", (state) => {
      if (state.phase === "recording") events.push({ type: "state:recording", at: Date.now() });
    });

    const beforeStart = Date.now();
    const result = await runtime.start("button");
    const afterStart = Date.now();

    const started = events.find((event) => event.type === "started");
    const recordingState = events.find((event) => event.type === "state:recording");
    expect(started).toBeDefined();
    expect(recordingState).toBeDefined();
    expect(result?.sessionId).toBeTruthy();
    // The started event must fire before cpal.createStream returns.
    expect(started!.at).toBeLessThan(resolvedAt.ms);
    expect(recordingState!.at).toBeLessThan(resolvedAt.ms);
    // createStream must actually have been the slow path the test simulated.
    expect(resolvedAt.ms - openedAt.ms).toBeGreaterThanOrEqual(450);
    // And the total start() wall clock includes the simulated hardware delay.
    expect(afterStart - beforeStart).toBeGreaterThanOrEqual(450);
  });
});
