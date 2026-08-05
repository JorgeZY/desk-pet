import { describe, expect, it, vi } from "vitest";
import {
  createCpalInputStream,
  openDefaultCpalInput,
  WarmCpalInput,
  type CpalModuleLike,
} from "./speech-runtime";

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

  it("keeps the microphone stream warm between recordings", () => {
    const handle = { streamId: "warm" };
    const createStream = vi.fn((_deviceId: string, _input: boolean, _config: unknown, onData: (samples: Float32Array) => void) => {
      onData(new Float32Array([0.25]));
      return handle;
    });
    const closeStream = vi.fn();
    const onData = vi.fn();
    const cpal: CpalModuleLike = {
      getDefaultInputDevice: () => ({ deviceId: "mic", name: "Test mic" }),
      getDefaultInputConfig: () => ({ sampleRate: 48000 }),
      createStream,
      closeStream,
    };
    const microphone = new WarmCpalInput(cpal, onData);

    expect(microphone.ensureDefault().stream).toBe(handle);
    expect(microphone.ensureDefault().stream).toBe(handle);

    expect(createStream).toHaveBeenCalledOnce();
    expect(closeStream).not.toHaveBeenCalled();
    expect(onData).toHaveBeenCalledOnce();
  });

  it("re-queries the default microphone but only reopens it after a switch", () => {
    let currentDevice = { deviceId: "built-in", name: "Built-in mic" };
    const createStream = vi.fn((deviceId: string) => ({ deviceId }));
    const closeStream = vi.fn();
    const cpal: CpalModuleLike = {
      getDefaultInputDevice: vi.fn(() => currentDevice),
      getDefaultInputConfig: vi.fn(() => ({ sampleRate: 48000 })),
      createStream,
      closeStream,
    };
    const microphone = new WarmCpalInput(cpal, vi.fn());

    expect(microphone.ensureDefault().device.deviceId).toBe("built-in");
    expect(microphone.ensureDefault().device.deviceId).toBe("built-in");
    currentDevice = { deviceId: "headset", name: "USB headset" };
    expect(microphone.ensureDefault().device.deviceId).toBe("headset");
    expect(createStream.mock.calls.map(([deviceId]) => deviceId)).toEqual(["built-in", "headset"]);
    expect(closeStream).toHaveBeenCalledWith({ deviceId: "built-in" });
  });

  it("stops forwarding samples from the previous microphone after a switch", () => {
    let currentDevice = { deviceId: "built-in", name: "Built-in mic" };
    const callbacks = new Map<string, (samples: Float32Array) => void>();
    const cpal: CpalModuleLike = {
      getDefaultInputDevice: () => currentDevice,
      getDefaultInputConfig: () => ({ sampleRate: 48000 }),
      createStream: (deviceId, _input, _config, onData) => {
        callbacks.set(deviceId, onData);
        return { deviceId };
      },
      closeStream: () => undefined,
    };
    const onData = vi.fn();
    const microphone = new WarmCpalInput(cpal, onData);

    microphone.ensureDefault();
    callbacks.get("built-in")?.(new Float32Array([0.1]));
    currentDevice = { deviceId: "headset", name: "USB headset" };
    microphone.ensureDefault();
    callbacks.get("built-in")?.(new Float32Array([0.2]));
    callbacks.get("headset")?.(new Float32Array([0.3]));

    expect(onData).toHaveBeenCalledTimes(2);
    expect(onData.mock.calls[0]?.[0][0]).toBeCloseTo(0.1);
    expect(onData.mock.calls[1]?.[0][0]).toBeCloseTo(0.3);
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

  it("releases the warm microphone stream on close", () => {
    const handle = { streamId: "warm" };
    const closeStream = vi.fn();
    const cpal: CpalModuleLike = {
      getDefaultInputDevice: () => ({ deviceId: "mic", name: "Test mic" }),
      getDefaultInputConfig: () => ({ sampleRate: 48000 }),
      createStream: () => handle,
      closeStream,
    };
    const microphone = new WarmCpalInput(cpal, vi.fn());

    microphone.ensureDefault();
    microphone.close();

    expect(microphone.input).toBeUndefined();
    expect(closeStream).toHaveBeenCalledWith(handle);
  });
});
