import { describe, expect, it, vi } from "vitest";
import {
  createCpalInputStream,
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
});
