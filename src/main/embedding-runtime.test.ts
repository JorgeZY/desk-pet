import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmbeddingState, RuntimeConfig } from "../shared/types";
import { DEFAULT_CONFIG } from "./config-store";
import {
  EMBEDDING_QUERY_INSTRUCTION,
  EmbeddingRuntime,
  formatEmbeddingQuery,
  parseEmbeddingResponse,
} from "./embedding-runtime";
import {
  buildEmbeddingLlamaCommand,
  embeddingModelAlias,
} from "./llama-command";
import { MANAGED_EMBEDDING_MODEL } from "./model-downloader";

const temporaryDirectories: string[] = [];
const MANAGED_EMBEDDING_MODEL_ALIAS = embeddingModelAlias(MANAGED_EMBEDDING_MODEL.sha256);

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

function runtimeConfig(overrides: Partial<RuntimeConfig["embedding"]> = {}): RuntimeConfig {
  return {
    ...DEFAULT_CONFIG,
    embedding: {
      ...DEFAULT_CONFIG.embedding,
      ...overrides,
    },
  };
}

function unitVector(dimensions: number, axis = 0): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  vector[axis % dimensions] = 1;
  return vector;
}

function embeddingResponse(
  count: number,
  dimensions = MANAGED_EMBEDDING_MODEL.dimensions,
  model = MANAGED_EMBEDDING_MODEL_ALIAS,
): Response {
  return Response.json({
    object: "list",
    model,
    data: Array.from({ length: count }, (_, index) => ({
      object: "embedding",
      index,
      embedding: unitVector(dimensions, index),
    })),
    usage: { prompt_tokens: count, total_tokens: count },
  });
}

function fakeChild(pid = 4_601): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as EventEmitter & Partial<ChildProcessWithoutNullStreams> & {
    killed: boolean;
    exitCode: number | null;
  };
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.killed = false;
  child.exitCode = null;
  child.kill = vi.fn(() => {
    child.killed = true;
    child.emit("exit", 0, null);
    return true;
  });
  return child as ChildProcessWithoutNullStreams;
}

describe("buildEmbeddingLlamaCommand", () => {
  it("uses llama serve with the dedicated embedding flags", () => {
    const command = buildEmbeddingLlamaCommand(runtimeConfig({
      port: 19_001,
      contextSize: 2_048,
      gpuLayers: 0,
      threads: 3,
    }));

    expect(command.command).toBe("llama");
    expect(command.args.slice(0, 3)).toEqual([
      "serve",
      "-hf",
      DEFAULT_CONFIG.embedding.hfRepo,
    ]);
    expect(command.args).toEqual(expect.arrayContaining([
      "--port", "19001",
      "-c", "2048",
      "--alias", "desk-pet-embedding",
      "--embedding",
      "--pooling", "last",
      "--embd-normalize", "2",
      "-ngl", "0",
      "-t", "3",
      "--no-webui",
    ]));
    expect(command.args).not.toContain("--jinja");
    expect(command.args).not.toContain("--tools");
    expect(command.args).not.toContain("--mmproj");
  });

  it("uses a resolved local model with llama-server.exe and no serve subcommand", () => {
    const direct = buildEmbeddingLlamaCommand({
      ...runtimeConfig(),
      executable: "C:\\llama.cpp\\llama-server.exe",
    }, "D:\\models\\Qwen3-Embedding-0.6B-Q8_0.gguf");

    expect(direct.args.slice(0, 2)).toEqual([
      "-m",
      "D:\\models\\Qwen3-Embedding-0.6B-Q8_0.gguf",
    ]);
    expect(direct.args).not.toContain("serve");
  });
});

describe("embedding response contract", () => {
  it("formats only query inputs with the exact Qwen instruction", () => {
    expect(formatEmbeddingQuery("  如何加载模型？  ")).toBe(
      `Instruct: ${EMBEDDING_QUERY_INSTRUCTION}\nQuery:如何加载模型？`,
    );
  });

  it("orders embeddings by index and validates dimensions and normalization", () => {
    const vectors = parseEmbeddingResponse({
      object: "list",
      data: [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] },
      ],
    }, 2, 2);

    expect(vectors).toEqual([[1, 0], [0, 1]]);
  });

  it("rejects malformed, wrong-dimension, and non-normalized vectors", () => {
    expect(() => parseEmbeddingResponse({ object: "list", data: [] }, 1, 2))
      .toThrow("预期 1 个");
    expect(() => parseEmbeddingResponse({
      object: "list",
      data: [{ index: 0, embedding: [1, 0, 0] }],
    }, 1, 2)).toThrow("预期 2 维");
    expect(() => parseEmbeddingResponse({
      object: "list",
      data: [{ index: 0, embedding: [2, 0] }],
    }, 1, 2)).toThrow("未按 L2 归一化");
  });
});

describe("EmbeddingRuntime", () => {
  it("does not download from ensureReady and reports an uncached model", async () => {
    const resolver = vi.fn(async () => null);
    const fetchApi = vi.fn(async () => new Response("not running", { status: 503 }));
    const spawnProcess = vi.fn();
    const runtime = new EmbeddingRuntime(
      runtimeConfig(),
      resolver,
      fetchApi as unknown as typeof fetch,
      { spawnProcess: spawnProcess as unknown as typeof spawn },
    );

    await expect(runtime.ensureReady()).rejects.toThrow("尚未下载");
    expect(resolver).toHaveBeenCalledWith(
      DEFAULT_CONFIG.embedding.hfRepo,
      expect.objectContaining({ allowDownload: false, forceDownload: false }),
    );
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(runtime.snapshot.phase).toBe("not-installed");
  });

  it("does not revive after stop aborts an in-flight health probe", async () => {
    const fetchApi = vi.fn((_input: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () => reject(new DOMException("aborted", "AbortError"));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      }));
    const resolver = vi.fn(async () => null);
    const runtime = new EmbeddingRuntime(
      runtimeConfig(),
      resolver,
      fetchApi,
    );

    const starting = runtime.start(false);
    await vi.waitFor(() => expect(runtime.snapshot.phase).toBe("starting"));
    await runtime.stop();

    await expect(starting).resolves.toMatchObject({ phase: "stopped" });
    expect(resolver).not.toHaveBeenCalled();
    expect(runtime.snapshot.phase).toBe("stopped");
  });

  it("downloads only through prepare, launches a second process, probes it, and emits state", async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), "desk-pet-embedding-runtime-"));
    temporaryDirectories.push(directory);
    const modelPath = join(directory, MANAGED_EMBEDDING_MODEL.filename);
    await fs.writeFile(modelPath, "GGUF-test");
    const resolver = vi.fn(async () => modelPath);
    let healthChecks = 0;
    const requests: Array<{ url: string; body?: unknown }> = [];
    const fetchApi = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        healthChecks += 1;
        return new Response("ok", { status: healthChecks === 1 ? 503 : 200 });
      }
      if (url.endsWith("/v1/models")) {
        return Response.json({ data: [{ id: MANAGED_EMBEDDING_MODEL_ALIAS }] });
      }
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url, body });
      return embeddingResponse((body as { input: unknown[] }).input.length);
    });
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child);
    const runtime = new EmbeddingRuntime(
      runtimeConfig(),
      resolver,
      fetchApi as unknown as typeof fetch,
      {
        spawnProcess: spawnProcess as unknown as typeof spawn,
        hashModelFile: async () => MANAGED_EMBEDDING_MODEL.sha256,
        readinessPollMs: 1,
        readinessTimeoutMs: 1_000,
      },
    );
    const phases: EmbeddingState["phase"][] = [];
    runtime.on("state", (state: EmbeddingState) => phases.push(state.phase));

    const state = await runtime.prepare(true);

    expect(state).toMatchObject({
      phase: "ready",
      pid: child.pid,
      modelPath,
      embeddingDimension: 1_024,
    });
    expect(resolver).toHaveBeenCalledWith(
      DEFAULT_CONFIG.embedding.hfRepo,
      expect.objectContaining({ allowDownload: true, forceDownload: true }),
    );
    expect(spawnProcess).toHaveBeenCalledWith(
      "llama",
      expect.arrayContaining(["serve", "-m", modelPath, "--embedding"]),
      expect.objectContaining({ windowsHide: true, stdio: "pipe" }),
    );
    expect(requests[0]?.body).toMatchObject({
      model: MANAGED_EMBEDDING_MODEL_ALIAS,
      encoding_format: "float",
    });
    expect(phases).toEqual(expect.arrayContaining(["downloading", "starting", "ready"]));
    await runtime.stop();
    expect(child.kill).toHaveBeenCalled();
  });

  it("embeds documents in bounded batches and prefixes only queries", async () => {
    const embeddingInputs: string[][] = [];
    const fetchApi = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/health")) return Response.json({ status: "ok" });
      if (url.endsWith("/v1/models")) {
        return Response.json({ data: [{ id: MANAGED_EMBEDDING_MODEL_ALIAS }] });
      }
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      embeddingInputs.push(body.input);
      return embeddingResponse(body.input.length);
    });
    const runtime = new EmbeddingRuntime(
      runtimeConfig(),
      undefined,
      fetchApi as unknown as typeof fetch,
    );
    const documents = Array.from({ length: 9 }, (_, index) => `document-${index}`);

    expect(await runtime.embedDocuments(documents)).toHaveLength(9);
    expect(await runtime.embedQuery("什么是本地知识库？")).toHaveLength(1_024);

    expect(embeddingInputs[0]?.[0]).toContain("Instruct:");
    expect(embeddingInputs[1]).toEqual(documents.slice(0, 8));
    expect(embeddingInputs[2]).toEqual(documents.slice(8));
    expect(embeddingInputs[3]?.[0]).toBe(formatEmbeddingQuery("什么是本地知识库？"));
  });

  it("rejects a same-dimension service whose alias has a different model digest", async () => {
    const wrongAlias = embeddingModelAlias("a".repeat(64));
    const fetchApi = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/health")) return new Response("ok");
      return Response.json({ data: [{ id: wrongAlias }] });
    });
    const runtime = new EmbeddingRuntime(
      runtimeConfig(),
      undefined,
      fetchApi as unknown as typeof fetch,
    );

    await expect(runtime.ensureReady()).rejects.toThrow("其他服务占用");
    expect(runtime.snapshot.phase).toBe("error");
  });

  it("changes the fingerprint and server alias when a local GGUF is replaced in place", async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), "desk-pet-local-embedding-"));
    temporaryDirectories.push(directory);
    const modelPath = join(directory, "local-embedding.gguf");
    await fs.writeFile(modelPath, "model-a");
    let activeChild: ChildProcessWithoutNullStreams | undefined;
    let activeAlias = "";
    const aliases: string[] = [];
    const fetchApi = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        const running = activeChild && !activeChild.killed && activeChild.exitCode === null;
        return new Response(running ? "ok" : "offline", { status: running ? 200 : 503 });
      }
      if (url.endsWith("/v1/models")) {
        return Response.json({ data: [{ id: activeAlias }] });
      }
      const body = JSON.parse(String(init?.body)) as { input: unknown[] };
      return embeddingResponse(body.input.length, 1_024, activeAlias);
    });
    let nextPid = 4_700;
    const spawnProcess = vi.fn((_command: string, args: readonly string[]) => {
      activeAlias = args[args.indexOf("--alias") + 1]!;
      aliases.push(activeAlias);
      activeChild = fakeChild(nextPid++);
      return activeChild;
    });
    const runtime = new EmbeddingRuntime(
      runtimeConfig({ modelMode: "local", modelPath }),
      undefined,
      fetchApi as unknown as typeof fetch,
      {
        spawnProcess: spawnProcess as unknown as typeof spawn,
        readinessPollMs: 1,
        readinessTimeoutMs: 1_000,
      },
    );

    await expect(runtime.start(false)).resolves.toMatchObject({ phase: "ready" });
    const firstFingerprint = runtime.fingerprint();
    await fs.writeFile(modelPath, "model-b");
    expect(runtime.fingerprint()).not.toBe(firstFingerprint);
    await runtime.stop();
    await expect(runtime.start(false)).resolves.toMatchObject({ phase: "ready" });
    const secondFingerprint = runtime.fingerprint();

    expect(firstFingerprint).toContain("sha256:");
    expect(secondFingerprint).toContain("sha256:");
    expect(secondFingerprint).not.toBe(firstFingerprint);
    expect(aliases).toHaveLength(2);
    expect(aliases[1]).not.toBe(aliases[0]);
    await runtime.stop();
  });

  it("rejects a local GGUF that changes between hashing and server readiness", async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), "desk-pet-local-toctou-"));
    temporaryDirectories.push(directory);
    const modelPath = join(directory, "local-embedding.gguf");
    await fs.writeFile(modelPath, "model-a");
    const modelASha256 = createHash("sha256").update("model-a").digest("hex");
    const modelAlias = embeddingModelAlias(modelASha256);
    let healthChecks = 0;
    const fetchApi = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        healthChecks += 1;
        if (healthChecks === 1) {
          await fs.writeFile(modelPath, "model-b");
          return new Response("offline", { status: 503 });
        }
        return new Response("ok");
      }
      if (url.endsWith("/v1/models")) {
        return Response.json({ data: [{ id: modelAlias }] });
      }
      const body = JSON.parse(String(init?.body)) as { input: unknown[] };
      return embeddingResponse(body.input.length, 1_024, modelAlias);
    });
    const child = fakeChild(4_750);
    const runtime = new EmbeddingRuntime(
      runtimeConfig({ modelMode: "local", modelPath }),
      undefined,
      fetchApi as unknown as typeof fetch,
      {
        spawnProcess: vi.fn(() => child) as unknown as typeof spawn,
        readinessPollMs: 1,
        readinessTimeoutMs: 1_000,
      },
    );

    await expect(runtime.start(false)).resolves.toMatchObject({
      phase: "error",
      error: expect.stringContaining("发生变化"),
    });
    expect(child.kill).toHaveBeenCalled();
    expect(runtime.snapshot.phase).toBe("error");
  });

  it("retains ownership when a probe-failed child refuses to exit", async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), "desk-pet-probe-stop-"));
    temporaryDirectories.push(directory);
    const modelPath = join(directory, MANAGED_EMBEDDING_MODEL.filename);
    await fs.writeFile(modelPath, "GGUF-test");
    let healthChecks = 0;
    const fetchApi = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        healthChecks += 1;
        return new Response(healthChecks === 1 ? "offline" : "ok", {
          status: healthChecks === 1 ? 503 : 200,
        });
      }
      return Response.json({ data: [{ id: "wrong-digest-alias" }] });
    });
    const child = fakeChild(4_760);
    child.kill = vi.fn(() => true);
    const runtime = new EmbeddingRuntime(
      runtimeConfig(),
      vi.fn(async () => modelPath),
      fetchApi as unknown as typeof fetch,
      {
        spawnProcess: vi.fn(() => child) as unknown as typeof spawn,
        hashModelFile: async () => MANAGED_EMBEDDING_MODEL.sha256,
        readinessPollMs: 1,
        readinessTimeoutMs: 1_000,
        shutdownTimeoutMs: 5,
      },
    );
    const internals = runtime as unknown as {
      child: ChildProcessWithoutNullStreams | null;
    };

    await expect(runtime.prepare()).resolves.toMatchObject({
      phase: "error",
      pid: child.pid,
    });
    expect(child.kill).toHaveBeenNthCalledWith(1);
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(internals.child).toBe(child);

    child.emit("exit", 0, null);
    expect(internals.child).toBeNull();
  });

  it("does not apply new configuration while an aborted startup is still unresolved", async () => {
    let resolveModel: ((value: string | null) => void) | undefined;
    const resolver = vi.fn(() => new Promise<string | null>((resolvePending) => {
      resolveModel = resolvePending;
    }));
    const runtime = new EmbeddingRuntime(
      runtimeConfig(),
      resolver,
      vi.fn(async () => new Response("offline", { status: 503 })) as unknown as typeof fetch,
      { shutdownTimeoutMs: 5 },
    );
    const starting = runtime.prepare();
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledOnce());

    await expect(runtime.updateConfig(runtimeConfig({ port: 19_004 })))
      .rejects.toThrow("未能及时结束");
    expect(runtime.endpoint).toBe(`http://127.0.0.1:${DEFAULT_CONFIG.embedding.port}`);
    expect(runtime.snapshot.phase).toBe("error");

    resolveModel?.(null);
    await starting;
  });

  it("keeps a non-exiting child attached and refuses to apply new configuration", async () => {
    const runtime = new EmbeddingRuntime(runtimeConfig(), undefined, globalThis.fetch, {
      shutdownTimeoutMs: 5,
    });
    const child = fakeChild(4_800);
    child.kill = vi.fn(() => true);
    const internals = runtime as unknown as {
      child: ChildProcessWithoutNullStreams | null;
      state: EmbeddingState;
    };
    internals.child = child;
    internals.state = { ...runtime.snapshot, phase: "ready", pid: child.pid };

    await expect(runtime.updateConfig(runtimeConfig({ port: 19_005 })))
      .rejects.toThrow("未能退出");
    expect(child.kill).toHaveBeenNthCalledWith(1);
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(internals.child).toBe(child);
    expect(runtime.endpoint).toBe(`http://127.0.0.1:${DEFAULT_CONFIG.embedding.port}`);

    child.emit("exit", 0, null);
    expect(internals.child).toBeNull();
  });

  it("publishes and preserves index statistics across stop", async () => {
    const runtime = new EmbeddingRuntime(runtimeConfig({ enabled: false }));
    const states: EmbeddingState[] = [];
    runtime.on("state", (state: EmbeddingState) => states.push(state));

    runtime.updateIndexStats({ indexedChunkCount: 12, pendingChunkCount: 3 });
    await runtime.stop();

    expect(runtime.snapshot).toMatchObject({
      indexedChunkCount: 12,
      pendingChunkCount: 3,
    });
    expect(states.at(-1)?.indexedChunkCount).toBe(12);
    expect(runtime.fingerprint()).toContain(MANAGED_EMBEDDING_MODEL.sha256);
    expect(runtime.fingerprint()).toContain("dimension:1024");
  });

  it("resets projected index statistics when the configured model changes", async () => {
    const runtime = new EmbeddingRuntime(runtimeConfig({ enabled: false }));
    runtime.updateIndexStats({ indexedChunkCount: 12, pendingChunkCount: 3 });

    await runtime.updateConfig(runtimeConfig({
      enabled: false,
      modelMode: "local",
      modelPath: "D:\\models\\another-embedding.gguf",
    }));

    expect(runtime.snapshot).toMatchObject({
      indexedChunkCount: 0,
      pendingChunkCount: 0,
    });
  });

  it("stops an active child before applying process configuration changes", async () => {
    const runtime = new EmbeddingRuntime(runtimeConfig());
    const child = fakeChild(4_602);
    const internals = runtime as unknown as {
      child: ChildProcessWithoutNullStreams | null;
      state: EmbeddingState;
    };
    internals.child = child;
    internals.state = {
      ...runtime.snapshot,
      phase: "ready",
      pid: child.pid,
      embeddingDimension: 1_024,
      indexedChunkCount: 5,
      pendingChunkCount: 2,
    };
    const next = runtimeConfig({ enabled: false, port: 19_003 });

    await runtime.updateConfig(next);

    expect(child.kill).toHaveBeenCalled();
    expect(runtime.endpoint).toBe("http://127.0.0.1:19003");
    expect(runtime.snapshot).toMatchObject({
      enabled: false,
      phase: "stopped",
      endpoint: "http://127.0.0.1:19003",
      indexedChunkCount: 5,
      pendingChunkCount: 2,
    });
  });
});
