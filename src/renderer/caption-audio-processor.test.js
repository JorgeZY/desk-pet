import { describe, expect, it } from "vitest";
import { CAPTION_AUDIO_CHUNK_SIZE, downmixChannels, rmsLevel } from "./public/caption-audio-processor.js";

describe("caption audio worklet", () => {
  it("batches PCM to reduce renderer-to-main scheduling pressure", () => {
    expect(CAPTION_AUDIO_CHUNK_SIZE).toBe(4096);
  });

  it("downmixes stereo system output to mono", () => {
    expect([...downmixChannels([
      new Float32Array([1, 0.5, -1]),
      new Float32Array([-1, 0.5, 1]),
    ])]).toEqual([0, 0.5, 0]);
  });

  it("returns an empty chunk when the capture graph has no input", () => {
    expect(downmixChannels([])).toHaveLength(0);
  });

  it("reports silence and audible PCM levels", () => {
    expect(rmsLevel(new Float32Array(128))).toBe(0);
    expect(rmsLevel(new Float32Array([1, -1, 1, -1]))).toBe(1);
  });
});
