import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MANAGED_MODEL,
  ManagedModelDownloader,
  type ModelFetch,
} from "./model-downloader";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(join(tmpdir(), "desk-pet-model-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("ManagedModelDownloader", () => {
  it("lets llama.cpp handle other Hugging Face model identifiers", async () => {
    const directory = await temporaryDirectory();
    const downloader = new ManagedModelDownloader(
      directory,
      async () => {
        throw new Error("should not fetch");
      },
      8,
    );

    await expect(
      downloader.resolve("another/model-GGUF:Q4_K_M", {
        signal: new AbortController().signal,
        onProgress: () => undefined,
      }),
    ).resolves.toBeNull();
  });

  it("falls back from ModelScope to Hugging Face", async () => {
    const directory = await temporaryDirectory();
    const requested: string[] = [];
    const payload = new TextEncoder().encode("GGUF-test-model");
    const fetchModel: ModelFetch = async (url) => {
      requested.push(url);
      if (url.includes("modelscope")) return new Response("unavailable", { status: 503 });
      return new Response(payload, {
        status: 200,
        headers: {
          "content-length": String(payload.byteLength),
          "content-type": "application/octet-stream",
        },
      });
    };
    const downloader = new ManagedModelDownloader(directory, fetchModel, 8);

    const path = await downloader.resolve(MANAGED_MODEL.id, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });

    expect(requested).toHaveLength(2);
    expect(requested[0]).toContain("modelscope");
    expect(requested[1]).toContain("huggingface");
    expect(await fs.readFile(path, "utf8")).toBe("GGUF-test-model");
  });

  it("resumes an incomplete download with a range request", async () => {
    const directory = await temporaryDirectory();
    const partialPath = join(directory, `${MANAGED_MODEL.filename}.part`);
    await fs.writeFile(partialPath, "GGU");
    const progress: number[] = [];
    const fetchModel: ModelFetch = async (_url, init) => {
      expect(new Headers(init?.headers).get("range")).toBe("bytes=3-");
      return new Response(new TextEncoder().encode("F-model"), {
        status: 206,
        headers: {
          "content-range": "bytes 3-9/10",
          "content-length": "7",
          "content-type": "application/octet-stream",
        },
      });
    };
    const downloader = new ManagedModelDownloader(directory, fetchModel, 8);

    const path = await downloader.resolve(MANAGED_MODEL.id, {
      signal: new AbortController().signal,
      onProgress: (value) => progress.push(value.receivedBytes),
    });

    expect(await fs.readFile(path, "utf8")).toBe("GGUF-model");
    expect(progress.at(-1)).toBe(10);
  });

  it("moves to the next mirror when a request never resolves", async () => {
    const directory = await temporaryDirectory();
    const payload = new TextEncoder().encode("GGUF-timeout-test");
    let calls = 0;
    const fetchModel: ModelFetch = async () => {
      calls += 1;
      if (calls === 1) return new Promise<Response>(() => undefined);
      return new Response(payload, {
        headers: {
          "content-length": String(payload.byteLength),
          "content-type": "application/octet-stream",
        },
      });
    };
    const downloader = new ManagedModelDownloader(directory, fetchModel, 8, 10);

    const path = await downloader.resolve(MANAGED_MODEL.id, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });

    expect(calls).toBe(2);
    expect(await fs.readFile(path, "utf8")).toBe("GGUF-timeout-test");
  });
});
