import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MANAGED_EMBEDDING_MODEL,
  MANAGED_MODEL,
  ManagedEmbeddingModelDownloader,
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

function sha256(payload: Uint8Array): string {
  return createHash("sha256").update(payload).digest("hex");
}

describe("ManagedEmbeddingModelDownloader", () => {
  it("pins the official Qwen Q8 artifact metadata", () => {
    expect(MANAGED_EMBEDDING_MODEL).toMatchObject({
      id: "Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0",
      filename: "Qwen3-Embedding-0.6B-Q8_0.gguf",
      sizeBytes: 639_150_592,
      sha256: "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
      dimensions: 1_024,
      license: "Apache-2.0",
      pooling: "last",
      normalize: 2,
    });
  });

  it("rejects a mirror with the wrong hash and falls back to the verified artifact", async () => {
    const directory = await temporaryDirectory();
    const payload = new TextEncoder().encode("GGUF-embedding-model");
    const corrupted = payload.slice();
    corrupted[5] ^= 0xff;
    const requested: string[] = [];
    const downloader = new ManagedEmbeddingModelDownloader(
      directory,
      async (url) => {
        requested.push(url);
        const body = url.includes("modelscope") ? corrupted : payload;
        return new Response(body, {
          headers: {
            "content-length": String(body.byteLength),
            "content-type": "application/octet-stream",
          },
        });
      },
      { sizeBytes: payload.byteLength, sha256: sha256(payload) },
    );

    const path = await downloader.resolve(MANAGED_EMBEDDING_MODEL.id, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });

    expect(requested).toHaveLength(2);
    expect(requested[0]).toContain("modelscope");
    expect(requested[1]).toContain("huggingface");
    expect(await fs.readFile(path!)).toEqual(Buffer.from(payload));
  });

  it("resumes a partial artifact and verifies its exact size and SHA-256", async () => {
    const directory = await temporaryDirectory();
    const payload = new TextEncoder().encode("GGUF-embedding-model");
    const partialPath = join(directory, `${MANAGED_EMBEDDING_MODEL.filename}.part`);
    await fs.writeFile(partialPath, payload.slice(0, 5));
    const downloader = new ManagedEmbeddingModelDownloader(
      directory,
      async (_url, init) => {
        expect(new Headers(init?.headers).get("range")).toBe("bytes=5-");
        return new Response(payload.slice(5), {
          status: 206,
          headers: {
            "content-range": `bytes 5-${payload.byteLength - 1}/${payload.byteLength}`,
            "content-length": String(payload.byteLength - 5),
            "content-type": "application/octet-stream",
          },
        });
      },
      { sizeBytes: payload.byteLength, sha256: sha256(payload) },
    );

    const path = await downloader.resolve(MANAGED_EMBEDDING_MODEL.id, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });

    expect(await fs.readFile(path!)).toEqual(Buffer.from(payload));
  });

  it("does not accept a same-size corrupt cache when downloads are disabled", async () => {
    const directory = await temporaryDirectory();
    const payload = new TextEncoder().encode("GGUF-embedding-model");
    const targetPath = join(directory, MANAGED_EMBEDDING_MODEL.filename);
    await fs.writeFile(targetPath, new Uint8Array(payload.byteLength).fill(7));
    let fetched = false;
    const downloader = new ManagedEmbeddingModelDownloader(
      directory,
      async () => {
        fetched = true;
        throw new Error("should not fetch");
      },
      { sizeBytes: payload.byteLength, sha256: sha256(payload) },
    );

    await expect(downloader.resolve(MANAGED_EMBEDDING_MODEL.id, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
      allowDownload: false,
    })).resolves.toBeNull();
    expect(fetched).toBe(false);
  });

  it("returns a verified cache without making a network request", async () => {
    const directory = await temporaryDirectory();
    const payload = new TextEncoder().encode("GGUF-embedding-model");
    const targetPath = join(directory, MANAGED_EMBEDDING_MODEL.filename);
    await fs.writeFile(targetPath, payload);
    const downloader = new ManagedEmbeddingModelDownloader(
      directory,
      async () => {
        throw new Error("should not fetch");
      },
      { sizeBytes: payload.byteLength, sha256: sha256(payload) },
    );

    await expect(downloader.resolve(MANAGED_EMBEDDING_MODEL.id, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    })).resolves.toBe(targetPath);
  });
});
