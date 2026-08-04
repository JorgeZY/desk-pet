import { describe, expect, it, vi } from "vitest";
import {
  createCpalInputStream,
  openDefaultCpalInput,
  warmCpalInput,
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
