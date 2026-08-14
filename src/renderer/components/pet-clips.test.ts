import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PET_CLIPS,
  PET_CHEERING_DURATION_MS,
  PET_DAYDREAMING_DURATION_MS,
  PET_DOZING_DURATION_MS,
  PET_EAR_SCRATCHING_DURATION_MS,
  PET_GROOMING_DURATION_MS,
  PET_IDLE_ACTIONS,
  PET_PERKING_UP_DURATION_MS,
  PET_YAWNING_DURATION_MS,
  petClipPlaybackSrc,
  preloadLoopingPetClips,
} from "./pet-clips";

const clipPath = (src: string) => fileURLToPath(
  new URL(`../public/${src.replace(/^\.\//, "").split("?")[0]}`, import.meta.url),
);

const actionSheetPath = (mood: "thinking" | "talking" | "sleeping" | "listening") =>
  fileURLToPath(new URL(
    `../../../assets/pet-source/pet-soft-pixel-${mood}-sheet-v1.png`,
    import.meta.url,
  ));

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
    const measuredSources = new Set<string>();

    for (const media of Object.values(PET_CLIPS)) {
      const path = clipPath(media.src);
      const stat = statSync(path);
      const header = readFileSync(path).subarray(0, 10);
      if (!measuredSources.has(media.src)) totalBytes += stat.size;
      measuredSources.add(media.src);

      expect(header.subarray(0, 6).toString("ascii")).toMatch(/^GIF8[79]a$/);
      expect(header.readUInt16LE(6)).toBe(432);
      expect(header.readUInt16LE(8)).toBe(540);
      expect(stat.size).toBeLessThan(2.5 * 1024 * 1024);
    }

    expect(totalBytes).toBeLessThan(16 * 1024 * 1024);
  });

  it.each([
    ["grooming", PET_GROOMING_DURATION_MS],
    ["yawning", PET_YAWNING_DURATION_MS],
    ["ear-scratching", PET_EAR_SCRATCHING_DURATION_MS],
  ] as const)("keeps the one-shot %s timer aligned with its GIF manifest", (action, durationMs) => {
    const data = readFileSync(clipPath(PET_CLIPS[action].src));

    expect(PET_CLIPS[action].loop).toBe(false);
    expect(PET_CLIPS[action].durationMs).toBe(durationMs);
    expect(readGifDurationMs(data)).toBe(durationMs);
    expect(data.includes(Buffer.from("NETSCAPE2.0", "ascii"))).toBe(false);
  });

  it.each([
    ["daydreaming", "thinking", PET_DAYDREAMING_DURATION_MS],
    ["cheering", "talking", PET_CHEERING_DURATION_MS],
    ["dozing", "sleeping", PET_DOZING_DURATION_MS],
    ["perking-up", "listening", PET_PERKING_UP_DURATION_MS],
  ] as const)("reuses mood artwork for idle action %s without another asset", (action, mood, durationMs) => {
    expect(PET_CLIPS[action].src).toBe(PET_CLIPS[mood].src);
    expect(PET_CLIPS[action].loop).toBe(false);
    expect(PET_CLIPS[action].durationMs).toBe(durationMs);
    const data = readFileSync(clipPath(PET_CLIPS[mood].src));
    expect(durationMs % readGifDurationMs(data)).toBe(0);
  });

  it.each([
    ["thinking", PET_DAYDREAMING_DURATION_MS],
    ["talking", PET_CHEERING_DURATION_MS / 2],
    ["sleeping", PET_DOZING_DURATION_MS],
    ["listening", PET_PERKING_UP_DURATION_MS],
  ] as const)("builds %s from a dedicated expressive animation", (mood, durationMs) => {
    const durations = readGifFrameDurationsMs(readFileSync(clipPath(PET_CLIPS[mood].src)));
    expect(durations.length).toBeGreaterThanOrEqual(3);
    expect(durations.reduce((total, duration) => total + duration, 0)).toBe(durationMs);
  });

  it.each([
    ["thinking", [200, 650, 3_100, 650, 200]],
    ["listening", [250, 900, 1_650, 900, 700]],
  ] as const)("holds a resting endpoint around the %s action", (mood, expectedDurations) => {
    const data = readFileSync(clipPath(PET_CLIPS[mood].src));
    const durations = readGifFrameDurationsMs(data);
    expect(durations).toEqual(expectedDurations);
  });

  it.each([
    ["thinking", "8db7a77497a4"],
    ["listening", "3adb18e68ec3"],
  ] as const)("binds the %s cache revision to its GIF content", (mood, revision) => {
    const media = PET_CLIPS[mood];
    const data = readFileSync(clipPath(media.src));
    const digest = createHash("sha256").update(data).digest("hex");

    expect(media.src).toContain(`?rev=${revision}`);
    expect(digest.startsWith(revision)).toBe(true);
  });

  it("ships four distinct transparent source sheets for the expressive moods", () => {
    const hashes = new Set<string>();
    for (const mood of ["thinking", "talking", "sleeping", "listening"] as const) {
      const data = readFileSync(actionSheetPath(mood));
      expect(data.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(data.readUInt32BE(16)).toBe(1254);
      expect(data.readUInt32BE(20)).toBe(1254);
      expect(data[25]).toBe(6);
      hashes.add(createHash("sha256").update(data).digest("hex"));
    }
    expect(hashes.size).toBe(4);
  });

  it("keeps every mood clip looping", () => {
    for (const [state, media] of Object.entries(PET_CLIPS)) {
      if (PET_IDLE_ACTIONS.includes(state as (typeof PET_IDLE_ACTIONS)[number])) continue;
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

  it("preloads only stable loop URLs and never an action playback URL", () => {
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
      expect(requestedSources.every((src) => !src.includes("?play="))).toBe(true);
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
    expect(petClipPlaybackSrc("yawning", "one")).toBe(
      `${PET_CLIPS.yawning.src}?play=one`,
    );
    expect(petClipPlaybackSrc("ear-scratching", "one")).toBe(
      `${PET_CLIPS["ear-scratching"].src}?play=one`,
    );
    expect(petClipPlaybackSrc("daydreaming", "one")).toBe(
      `${PET_CLIPS.daydreaming.src}&play=one`,
    );
  });
});
