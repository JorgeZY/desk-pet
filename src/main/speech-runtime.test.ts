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

describe("SpeechRuntime microphone lifecycle", () => {
  const temporaryDirectories: string[] = [];
  const testRoot = join(process.cwd(), ".test-tmp", "speech-runtime-lifecycle");

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

  function makeSherpa(): SherpaModule {
    const onlineStream = {
      acceptWaveform: () => undefined,
      inputFinished: () => undefined,
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
    return {
      OnlineRecognizer: vi.fn(() => onlineRecognizer),
      OfflineRecognizer: vi.fn(() => offlineRecognizer),
      LinearResampler: vi.fn(() => ({
        resample: (samples: Float32Array) => samples,
        flush: (samples: Float32Array) => samples,
      })),
    } as unknown as SherpaModule;
  }

  function makeCpal(): { cpal: CpalModuleLike; createStream: ReturnType<typeof vi.fn> } {
    const createStream = vi.fn((_deviceId: string, _isInput: boolean, _config: unknown, _onData: unknown) => ({
      streamId: "long-lived",
    }));
    const cpal: CpalModuleLike = {
      getDefaultInputDevice: vi.fn(() => ({ deviceId: "default-mic", name: "Default mic" })),
      getDefaultInputConfig: vi.fn(() => ({ sampleRate: 48000 })),
      createStream,
      closeStream: () => undefined,
    };
    return { cpal, createStream };
  }

  it("keeps the cpal stream alive across multiple recordings", async () => {
    const models = await makeReadyModels();
    const sherpa = makeSherpa();
    const { cpal, createStream } = makeCpal();
    const runtime = new SpeechRuntime(makeConfig(), models, { sherpa, cpal });

    const first = await runtime.start("button");
    expect(first?.sessionId).toBeTruthy();
    expect(createStream).toHaveBeenCalledTimes(1);

    if (first) await runtime.stop(first.sessionId);

    const second = await runtime.start("shortcut");
    expect(second?.sessionId).toBeTruthy();
    // The cpal stream stays long-lived; no new createStream call for the
    // second recording, so F8 startup stays instant regardless of how slow
    // the audio driver is at negotiating a fresh WASAPI client.
    expect(createStream).toHaveBeenCalledTimes(1);

    if (second) await runtime.stop(second.sessionId);
  });

  it("rebinds samples from the warm stream to the active session", async () => {
    const models = await makeReadyModels();
    const sherpa = makeSherpa();
    const acceptWaveform = vi.fn();
    (sherpa.OnlineRecognizer as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      createStream: vi.fn(() => ({
        acceptWaveform,
        inputFinished: () => undefined,
      })),
      isReady: () => false,
      decode: () => undefined,
      getResult: () => ({ text: "" }),
    }));
    let capturedCallback: ((samples: Float32Array) => void) | undefined;
    const createStream = vi.fn((_deviceId: string, _isInput: boolean, _config: unknown, onData: unknown) => {
      capturedCallback = onData as (samples: Float32Array) => void;
      return { streamId: "long-lived" };
    });
    const cpal: CpalModuleLike = {
      getDefaultInputDevice: vi.fn(() => ({ deviceId: "default-mic", name: "Default mic" })),
      getDefaultInputConfig: vi.fn(() => ({ sampleRate: 48000 })),
      createStream,
      closeStream: () => undefined,
    };
    const runtime = new SpeechRuntime(makeConfig(), models, { sherpa, cpal });

    const first = await runtime.start("button");
    expect(first?.sessionId).toBeTruthy();
    expect(capturedCallback).toBeDefined();

    // Push a chunk through the long-lived warm callback; the runtime must
    // route it to the active session's per-recognition sherpa stream.
    capturedCallback!(new Float32Array([0.1, 0.2, 0.3]));
    expect(acceptWaveform).toHaveBeenCalledWith({ sampleRate: 16000, samples: expect.any(Float32Array) });

    if (first) await runtime.stop(first.sessionId);
  });

  it("rebuilds the warm stream when the default device changes between recordings", async () => {
    const models = await makeReadyModels();
    const sherpa = makeSherpa();
    let currentDeviceId = "default-mic";
    const createStream = vi.fn((deviceId: string) => ({ streamId: deviceId }));
    const closeStream = vi.fn();
    const cpal: CpalModuleLike = {
      getDefaultInputDevice: vi.fn(() => ({ deviceId: currentDeviceId, name: currentDeviceId })),
      getDefaultInputConfig: vi.fn(() => ({ sampleRate: 48000 })),
      createStream,
      closeStream,
    };
    const runtime = new SpeechRuntime(makeConfig(), models, { sherpa, cpal });

    const first = await runtime.start("button");
    expect(createStream).toHaveBeenCalledTimes(1);
    if (first) await runtime.stop(first.sessionId);

    currentDeviceId = "usb-headset";
    const second = await runtime.start("button");
    // Device changed → old stream is closed and a fresh one is opened against
    // the new endpoint before the recording starts.
    expect(closeStream).toHaveBeenCalled();
    expect(createStream).toHaveBeenCalledTimes(2);
    expect(createStream.mock.calls[1][0]).toBe("usb-headset");
    if (second) await runtime.stop(second.sessionId);
  });
});
