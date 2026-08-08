import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PET_CLIPS,
  PET_GROOMING_DURATION_MS,
  petClipPlaybackSrc,
  preloadLoopingPetClips,
} from "./pet-clips";
import { PET_GROOMING_TIMING } from "./pet-grooming";

const clipPath = (src: string) => fileURLToPath(
  new URL(`../public/${src.replace(/^\.\//, "")}`, import.meta.url),
);

function skipSubBlocks(data: Buffer, start: number) {
  let offset = start;
  while (offset < data.length) {
    const size = data[offset];
    offset += 1;
    if (size === 0) return offset;
    offset += size;
  }
  throw new Error("GIF sub-block extends past the file boundary");
}

function readGifFrameDurationsMs(data: Buffer) {
  const packed = data[10];
  const globalTableBytes = packed & 0x80
    ? 3 * (2 ** ((packed & 0x07) + 1))
    : 0;
  let offset = 13 + globalTableBytes;
  const durationsMs: number[] = [];

  while (offset < data.length) {
    const marker = data[offset];
    offset += 1;
    if (marker === 0x3b) break;

    if (marker === 0x21) {
      const label = data[offset];
      offset += 1;
      if (label === 0xf9) {
        const blockSize = data[offset];
        offset += 1;
        if (blockSize !== 4) throw new Error("Invalid GIF control extension");
        durationsMs.push(data.readUInt16LE(offset + 1) * 10);
        offset += blockSize + 1;
      } else {
        offset = skipSubBlocks(data, offset);
      }
      continue;
    }

    if (marker === 0x2c) {
      const localPacked = data[offset + 8];
      offset += 9;
      if (localPacked & 0x80) {
        offset += 3 * (2 ** ((localPacked & 0x07) + 1));
      }
      offset += 1;
      offset = skipSubBlocks(data, offset);
      continue;
    }

    throw new Error(`Unexpected GIF marker 0x${marker.toString(16)}`);
  }

  return durationsMs;
}

function readGifDurationMs(data: Buffer) {
  return readGifFrameDurationsMs(data).reduce(
    (total, durationMs) => total + durationMs,
    0,
  );
}

describe("pet GIF clips", () => {
  it("ships every clip as a bounded 432 x 540 GIF", () => {
    let totalBytes = 0;

    for (const media of Object.values(PET_CLIPS)) {
      const path = clipPath(media.src);
      const stat = statSync(path);
      const header = readFileSync(path).subarray(0, 10);
      totalBytes += stat.size;

      expect(header.subarray(0, 6).toString("ascii")).toMatch(/^GIF8[79]a$/);
      expect(header.readUInt16LE(6)).toBe(432);
      expect(header.readUInt16LE(8)).toBe(540);
      expect(stat.size).toBeLessThan(2.5 * 1024 * 1024);
    }

    expect(totalBytes).toBeLessThan(11 * 1024 * 1024);
  });

  it("keeps the one-shot grooming timer aligned with its GIF manifest", () => {
    const groomingData = readFileSync(clipPath(PET_CLIPS.grooming.src));

    expect(PET_CLIPS.grooming.loop).toBe(false);
    expect(PET_CLIPS.grooming.durationMs).toBe(PET_GROOMING_DURATION_MS);
    expect(PET_GROOMING_TIMING.durationMs).toBe(PET_GROOMING_DURATION_MS);
    expect(readGifDurationMs(groomingData)).toBe(PET_GROOMING_DURATION_MS);
    expect(groomingData.includes(Buffer.from("NETSCAPE2.0", "ascii"))).toBe(false);
  });

  it("keeps every mood clip looping", () => {
    for (const [state, media] of Object.entries(PET_CLIPS)) {
      if (state === "grooming") continue;
      const data = readFileSync(clipPath(media.src));
      expect(media.loop).toBe(true);
      expect(readGifDurationMs(data)).toBeGreaterThan(0);
      expect(data.includes(Buffer.from("NETSCAPE2.0", "ascii"))).toBe(true);
    }
  });

  it("holds the idle blink long enough to read without feeling frozen", () => {
    const idleData = readFileSync(clipPath(PET_CLIPS.idle.src));
    expect(readGifFrameDurationsMs(idleData)[15]).toBe(160);
  });

  it("never starts the one-shot grooming GIF during preload", () => {
    const originalImage = globalThis.Image;
    const requestedSources: string[] = [];

    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(value: string) {
        requestedSources.push(value);
        this.onload?.();
      }
    }

    Object.defineProperty(globalThis, "Image", {
      configurable: true,
      value: FakeImage as unknown as typeof Image,
    });

    try {
      preloadLoopingPetClips();
      expect(requestedSources).toHaveLength(7);
      expect(requestedSources).not.toContain(PET_CLIPS.grooming.src);
    } finally {
      Object.defineProperty(globalThis, "Image", {
        configurable: true,
        value: originalImage,
      });
    }
  });

  it("gives each one-shot playback a fresh URL without fragmenting loop URLs", () => {
    expect(petClipPlaybackSrc("idle", "one")).toBe(PET_CLIPS.idle.src);
    expect(petClipPlaybackSrc("grooming", "one")).toBe(
      `${PET_CLIPS.grooming.src}?play=one`,
    );
    expect(petClipPlaybackSrc("grooming", "two")).not.toBe(
      petClipPlaybackSrc("grooming", "one"),
    );
  });
});
