import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  EmbeddingState,
  ModelDownloadProgress,
  RuntimeConfig,
} from "../shared/types";
import {
  formatBytes,
  MANAGED_EMBEDDING_MODEL,
  type ModelFetch,
  type ResolveModelOptions,
} from "./model-downloader";
import {
  buildEmbeddingLlamaCommand,
  embeddingModelAlias,
  LLAMA_CPP_EMBEDDING_MODEL_ALIAS,
} from "./llama-command";

export type ManagedEmbeddingModelResolver = (
  modelId: string,
  options: ResolveModelOptions,
) => Promise<string | null>;

export const EMBEDDING_QUERY_INSTRUCTION =
  "Given a user question, retrieve relevant passages from the local knowledge base that answer the question";
export const EMBEDDING_QUERY_INSTRUCTION_VERSION = "qwen3-local-knowledge-v1";
export const EMBEDDING_REQUEST_BATCH_SIZE = 8;

export interface EmbeddingRuntimeOptions {
  spawnProcess?: typeof spawn;
  readinessTimeoutMs?: number;
  readinessPollMs?: number;
  healthTimeoutMs?: number;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  hashModelFile?: (path: string, signal: AbortSignal) => Promise<string>;
}

interface EmbeddingListResponse {
  object?: unknown;
  data?: unknown;
}

interface VerifiedLocalModel {
  path: string;
  size: number;
  modifiedAt: number;
  sha256: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function diagnostic(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(-500);
}

function endpointFor(config: RuntimeConfig): string {
  return `http://${config.host}:${config.embedding.port}`;
}

function displayedModelPath(config: RuntimeConfig): string {
  return config.embedding.modelMode === "local"
    ? config.embedding.modelPath
    : config.embedding.hfRepo;
}

function normalizedLocalModelPath(path: string): string {
  return resolve(path.trim()).toLocaleLowerCase();
}

function configuredModelKey(config: RuntimeConfig): string {
  return config.embedding.modelMode === "huggingface"
    ? `huggingface:${config.embedding.hfRepo.trim().toLowerCase()}`
    : `local:${normalizedLocalModelPath(config.embedding.modelPath)}`;
}

async function sha256File(path: string, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    const onAbort = () => stream.destroy(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolveHash(hash.digest("hex")));
    stream.once("close", () => signal.removeEventListener("abort", onAbort));
    if (signal.aborted) onAbort();
  });
}

function initialState(config: RuntimeConfig): EmbeddingState {
  return {
    enabled: config.embedding.enabled,
    phase: "stopped",
    endpoint: endpointFor(config),
    modelPath: displayedModelPath(config),
    message: config.embedding.enabled ? "向量模型尚未启动。" : "向量检索已关闭。",
    indexedChunkCount: 0,
    pendingChunkCount: 0,
    updatedAt: Date.now(),
  };
}

function abortError(): DOMException {
  return new DOMException("操作已取消", "AbortError");
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortError()));
    const timer = setTimeout(() => finish(resolve), ms);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function settlesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function expectedDimension(config: RuntimeConfig): number | undefined {
  const identifier = config.embedding.modelMode === "huggingface"
    ? config.embedding.hfRepo.trim().toLowerCase()
    : config.embedding.modelPath.trim().toLowerCase();
  if (
    identifier === MANAGED_EMBEDDING_MODEL.id.toLowerCase()
    || identifier.endsWith(MANAGED_EMBEDDING_MODEL.filename.toLowerCase())
  ) {
    return MANAGED_EMBEDDING_MODEL.dimensions;
  }
  return undefined;
}

export function formatEmbeddingQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("Embedding query 不能为空。");
  return `Instruct: ${EMBEDDING_QUERY_INSTRUCTION}\nQuery:${trimmed}`;
}

export function parseEmbeddingResponse(
  payload: unknown,
  expectedCount: number,
  requiredDimension?: number,
): number[][] {
  if (!payload || typeof payload !== "object") {
    throw new Error("llama.cpp 返回了无效的 embedding JSON。");
  }
  const response = payload as EmbeddingListResponse;
  if (response.object !== "list" || !Array.isArray(response.data)) {
    throw new Error("llama.cpp 返回的 embedding 响应缺少 list/data。");
  }
  if (response.data.length !== expectedCount) {
    throw new Error(
      `llama.cpp 返回了 ${response.data.length} 个向量，预期 ${expectedCount} 个。`,
    );
  }

  const ordered = new Array<number[]>(expectedCount);
  let dimension = requiredDimension;
  for (const rawItem of response.data) {
    if (!rawItem || typeof rawItem !== "object") {
      throw new Error("llama.cpp 返回了无效的 embedding data 项。");
    }
    const item = rawItem as { index?: unknown; embedding?: unknown };
    if (!Number.isInteger(item.index) || (item.index as number) < 0 || (item.index as number) >= expectedCount) {
      throw new Error("llama.cpp 返回了越界的 embedding index。");
    }
    const index = item.index as number;
    if (ordered[index]) throw new Error(`llama.cpp 返回了重复的 embedding index ${index}。`);
    if (!Array.isArray(item.embedding) || item.embedding.length === 0) {
      throw new Error(`llama.cpp 返回的第 ${index} 个向量为空。`);
    }
    const vector = item.embedding.map((value) => {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`llama.cpp 返回的第 ${index} 个向量包含非有限数值。`);
      }
      return value;
    });
    dimension ??= vector.length;
    if (vector.length !== dimension) {
      throw new Error(
        `llama.cpp 返回了 ${vector.length} 维向量，预期 ${dimension} 维。`,
      );
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (norm < 0.99 || norm > 1.01) {
      throw new Error(`llama.cpp embedding 未按 L2 归一化（norm=${norm.toFixed(6)}）。`);
    }
    ordered[index] = vector;
  }
  if (ordered.some((vector) => !vector)) {
    throw new Error("llama.cpp 返回的 embedding index 不连续。");
  }
  return ordered;
}

export class EmbeddingRuntime extends EventEmitter {
  private config: RuntimeConfig;
  private state: EmbeddingState;
  private child: ChildProcessWithoutNullStreams | null = null;
  private generation = 0;
  private lifecycleController: AbortController | null = null;
  private startupWorkPromise: Promise<EmbeddingState> | null = null;
  private startupPromise: Promise<EmbeddingState> | null = null;
  private stopPromise: Promise<EmbeddingState> | null = null;
  private verifiedLocalModel: VerifiedLocalModel | null = null;
  private activeModelAlias = LLAMA_CPP_EMBEDDING_MODEL_ALIAS;
  private readonly unverifiedFingerprintNonce = randomBytes(8).toString("hex");
  private requestQueue: Promise<void> = Promise.resolve();
  private readonly requestControllers = new Set<AbortController>();
  private readonly spawnProcess: typeof spawn;
  private readonly readinessTimeoutMs: number;
  private readonly readinessPollMs: number;
  private readonly healthTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly hashModelFile: (path: string, signal: AbortSignal) => Promise<string>;

  constructor(
    config: RuntimeConfig,
    private readonly resolveManagedModel?: ManagedEmbeddingModelResolver,
    private readonly fetchEmbedding: ModelFetch = globalThis.fetch,
    options: EmbeddingRuntimeOptions = {},
  ) {
    super();
    this.config = config;
    this.state = initialState(config);
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? 30 * 60 * 1000;
    this.readinessPollMs = options.readinessPollMs ?? 1_000;
    this.healthTimeoutMs = options.healthTimeoutMs ?? 900;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 2_500;
    this.hashModelFile = options.hashModelFile ?? sha256File;
  }

  async updateConfig(config: RuntimeConfig): Promise<void> {
    const modelChanged = configuredModelKey(this.config) !== configuredModelKey(config);
    const processConfigChanged = this.config.executable !== config.executable
      || this.config.host !== config.host
      || JSON.stringify(this.config.embedding) !== JSON.stringify(config.embedding);
    const active = this.child !== null
      || this.state.phase === "starting"
      || this.state.phase === "downloading"
      || this.state.phase === "indexing"
      || this.state.phase === "ready"
      || this.state.phase === "stopping";
    if (processConfigChanged && active) {
      const stopped = await this.stop();
      if (stopped.phase !== "stopped" || this.child || this.startupWorkPromise) {
        throw new Error(stopped.error ?? "旧的 Embedding runtime 未能完全停止，配置未应用。");
      }
    }
    this.config = config;
    if (modelChanged) {
      this.verifiedLocalModel = null;
      this.activeModelAlias = LLAMA_CPP_EMBEDDING_MODEL_ALIAS;
    }
    if (this.state.phase === "stopped" || this.state.phase === "not-installed" || this.state.phase === "error") {
      this.state = {
        ...initialState(config),
        indexedChunkCount: modelChanged ? 0 : this.state.indexedChunkCount,
        pendingChunkCount: modelChanged ? 0 : this.state.pendingChunkCount,
      };
      this.emit("state", this.snapshot);
    }
  }

  get snapshot(): EmbeddingState {
    return {
      ...this.state,
      download: this.state.download ? { ...this.state.download } : undefined,
    };
  }

  get endpoint(): string {
    return endpointFor(this.config);
  }

  fingerprint(): string {
    const embedding = this.config.embedding;
    const configuredModel = embedding.modelMode === "huggingface"
      ? embedding.hfRepo.trim().toLowerCase()
      : normalizedLocalModelPath(embedding.modelPath);
    let localModelSha256: string | undefined;
    if (embedding.modelMode === "local" && this.verifiedLocalModel?.path === configuredModel) {
      try {
        const current = statSync(embedding.modelPath);
        if (
          current.size === this.verifiedLocalModel.size
          && current.mtimeMs === this.verifiedLocalModel.modifiedAt
        ) {
          localModelSha256 = this.verifiedLocalModel.sha256;
        }
      } catch {
        // The unverified nonce prevents stale vectors from being reused.
      }
    }
    let unverifiedModel = configuredModel;
    if (embedding.modelMode === "local") {
      try {
        const current = statSync(embedding.modelPath);
        unverifiedModel = `${configuredModel}:${current.size}:${current.mtimeMs}`;
      } catch {
        unverifiedModel = `${configuredModel}:missing`;
      }
    }
    const modelFingerprint = configuredModel === MANAGED_EMBEDDING_MODEL.id.toLowerCase()
      ? `sha256:${MANAGED_EMBEDDING_MODEL.sha256}`
      : localModelSha256
        ? `sha256:${localModelSha256}`
        : `${embedding.modelMode}:unverified:${this.unverifiedFingerprintNonce}:${unverifiedModel}`;
    return [
      "llama.cpp-embedding-v1",
      modelFingerprint,
      "pooling:last",
      "normalize:l2",
      `query:${EMBEDDING_QUERY_INSTRUCTION_VERSION}`,
      `dimension:${expectedDimension(this.config) ?? this.state.embeddingDimension ?? "auto"}`,
    ].join("|");
  }

  async prepare(force = false): Promise<EmbeddingState> {
    if (force) await this.stop();
    return this.beginStart(true, force);
  }

  async start(allowDownload = false): Promise<EmbeddingState> {
    return this.beginStart(allowDownload, false);
  }

  async ensureReady(): Promise<EmbeddingState> {
    const state = await this.start(false);
    if (state.phase !== "ready") {
      throw new Error(state.error ?? state.message ?? "Embedding runtime 未就绪。");
    }
    return state;
  }

  updateIndexStats(stats: {
    indexedChunkCount: number;
    pendingChunkCount: number;
  }): void {
    this.publish({
      indexedChunkCount: Number.isFinite(stats.indexedChunkCount)
        ? Math.max(0, Math.round(stats.indexedChunkCount))
        : 0,
      pendingChunkCount: Number.isFinite(stats.pendingChunkCount)
        ? Math.max(0, Math.round(stats.pendingChunkCount))
        : 0,
    });
  }

  async stop(): Promise<EmbeddingState> {
    if (this.stopPromise) return this.stopPromise;
    const operation = this.stopInternal();
    this.stopPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.stopPromise === operation) this.stopPromise = null;
    }
  }

  private async stopInternal(): Promise<EmbeddingState> {
    this.generation += 1;
    this.lifecycleController?.abort();
    for (const controller of this.requestControllers) controller.abort();
    this.requestControllers.clear();

    if (this.state.phase !== "stopped") {
      this.publish({
        phase: "stopping",
        message: "正在停止向量模型。",
        error: undefined,
        download: undefined,
      });
    }

    const startup = this.startupWorkPromise;
    const child = this.child;
    const [startupSettled, childStopped] = await Promise.all([
      startup ? settlesWithin(startup, this.shutdownTimeoutMs) : true,
      child ? this.terminateChild(child) : true,
    ]);
    if (!startupSettled || !childStopped || this.child) {
      return this.publish({
        phase: "error",
        message: "无法完全停止向量模型。",
        error: !startupSettled
          ? "Embedding 启动任务未能及时结束，请稍后重试。"
          : "llama.cpp embedding 进程未能退出，请退出桌宠后重试。",
        download: undefined,
        pid: this.child?.pid,
      });
    }

    const counts = {
      indexedChunkCount: this.state.indexedChunkCount,
      pendingChunkCount: this.state.pendingChunkCount,
    };
    this.state = { ...initialState(this.config), ...counts };
    this.emit("state", this.snapshot);
    return this.snapshot;
  }

  async embedQuery(query: string, signal?: AbortSignal): Promise<number[]> {
    await this.ensureReady();
    const vectors = await this.enqueueEmbedding(() =>
      this.embedTexts([formatEmbeddingQuery(query)], signal));
    const vector = vectors[0];
    if (!vector) throw new Error("llama.cpp 未返回 query embedding。");
    return vector;
  }

  async embedDocuments(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];
    const normalized = texts.map((text, index) => {
      if (typeof text !== "string" || !text.trim()) {
        throw new Error(`第 ${index + 1} 个 embedding document 为空。`);
      }
      return text;
    });
    await this.ensureReady();
    return this.enqueueEmbedding(() => this.embedTexts(normalized, signal));
  }

  private async beginStart(allowDownload: boolean, forceDownload: boolean): Promise<EmbeddingState> {
    if (this.stopPromise) await this.stopPromise;
    if (!this.config.embedding.enabled) {
      this.state = initialState(this.config);
      this.emit("state", this.snapshot);
      return this.snapshot;
    }
    if (this.state.phase === "ready") return this.snapshot;
    if (this.state.phase === "stopping") return this.snapshot;
    if (this.state.phase === "error" && (this.child || this.startupWorkPromise)) {
      return this.fail("旧的向量模型启动或停止操作尚未结束，请稍后重试。");
    }
    if (this.startupPromise) return this.startupPromise;

    const generation = ++this.generation;
    const controller = new AbortController();
    this.lifecycleController = controller;
    let work: Promise<EmbeddingState>;
    work = this.startInternal(
      generation,
      controller,
      allowDownload,
      forceDownload,
    ).catch((error) => {
      if (controller.signal.aborted || generation !== this.generation) return this.snapshot;
      return this.fail(message(error));
    }).finally(() => {
      if (this.lifecycleController === controller) this.lifecycleController = null;
      if (this.startupWorkPromise === work) this.startupWorkPromise = null;
    });
    this.startupWorkPromise = work;
    const operation = work.then(async (state) => {
      const stopping = this.stopPromise;
      return controller.signal.aborted && stopping ? stopping : state;
    });
    this.startupPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.startupPromise === operation) this.startupPromise = null;
    }
  }

  private async terminateChild(child: ChildProcessWithoutNullStreams): Promise<boolean> {
    if (child.exitCode !== null) {
      if (this.child === child) this.child = null;
      return true;
    }
    const exited = new Promise<void>((resolveExit) => child.once("exit", () => {
      if (this.child === child) this.child = null;
      resolveExit();
    }));
    try {
      child.kill();
    } catch {
      return false;
    }
    if (!await settlesWithin(exited, this.shutdownTimeoutMs)) {
      try {
        child.kill("SIGKILL");
      } catch {
        return false;
      }
      if (!await settlesWithin(exited, this.shutdownTimeoutMs)) return false;
    }
    return true;
  }

  private async failAfterTerminatingChild(
    child: ChildProcessWithoutNullStreams,
    error: string,
  ): Promise<EmbeddingState> {
    if (!await this.terminateChild(child)) {
      return this.publish({
        phase: "error",
        message: "Embedding runtime 启动失败，进程未能退出。",
        error,
        download: undefined,
        pid: child.pid,
      });
    }
    return this.fail(error);
  }

  private async startInternal(
    generation: number,
    controller: AbortController,
    allowDownload: boolean,
    forceDownload: boolean,
  ): Promise<EmbeddingState> {
    const launchConfig: RuntimeConfig = {
      ...this.config,
      embedding: { ...this.config.embedding },
    };
    this.validateLaunchConfig(launchConfig);
    this.publish({
      phase: "starting",
      endpoint: endpointFor(launchConfig),
      modelPath: displayedModelPath(launchConfig),
      message: "正在检查 llama.cpp 向量服务。",
      error: undefined,
      download: undefined,
      embeddingDimension: undefined,
    });

    let modelSha256: string;
    if (launchConfig.embedding.modelMode === "local") {
      this.publish({ message: "正在校验本地 Embedding GGUF。" });
      const verified = await this.verifyModelFile(
        launchConfig.embedding.modelPath,
        controller.signal,
      );
      if (generation !== this.generation || controller.signal.aborted) return this.snapshot;
      this.verifiedLocalModel = verified;
      modelSha256 = verified.sha256;
    } else {
      modelSha256 = MANAGED_EMBEDDING_MODEL.sha256;
    }
    const modelAlias = embeddingModelAlias(modelSha256);
    this.activeModelAlias = modelAlias;

    const healthy = await this.isHealthy(this.healthTimeoutMs, controller.signal);
    if (generation !== this.generation || controller.signal.aborted) return this.snapshot;
    if (healthy) {
      if (forceDownload) {
        throw new Error(
          `端口 ${launchConfig.embedding.port} 上已有向量服务，请先停止该服务再强制重新下载。`,
        );
      }
      const dimension = await this.probeEmbeddingServer(
        controller.signal,
        modelAlias,
        expectedDimension(launchConfig),
      );
      if (generation !== this.generation || controller.signal.aborted) return this.snapshot;
      return this.publish({
        phase: "ready",
        message: "已连接当前端口上的 llama.cpp 向量服务。",
        embeddingDimension: dimension,
        error: undefined,
      });
    }

    let resolvedModelPath: string | undefined;
    if (launchConfig.embedding.modelMode === "huggingface") {
      if (this.resolveManagedModel) {
        this.publish({
          phase: allowDownload ? "downloading" : "starting",
          message: allowDownload ? "正在准备 Qwen 向量模型。" : "正在检查本地向量模型缓存。",
        });
        resolvedModelPath = await this.resolveManagedModel(launchConfig.embedding.hfRepo, {
          signal: controller.signal,
          allowDownload,
          forceDownload,
          onProgress: (download) => this.updateDownloadState(generation, download),
        }) ?? undefined;
        if (generation !== this.generation || controller.signal.aborted) return this.snapshot;
        if (resolvedModelPath && !existsSync(resolvedModelPath)) {
          throw new Error("Embedding downloader 返回的 GGUF 文件不存在。");
        }
      }
      if (!resolvedModelPath) {
        if (!allowDownload) {
          return this.publish({
            phase: "not-installed",
            message: "Embedding 模型尚未下载。",
            download: undefined,
          });
        }
        throw new Error(
          "当前只自动管理官方 Qwen3-Embedding-0.6B-Q8；其他模型请切换为本地 GGUF。",
        );
      }
    }

    return this.launch(
      launchConfig,
      resolvedModelPath,
      modelAlias,
      modelSha256,
      generation,
      controller.signal,
    );
  }

  private validateLaunchConfig(config: RuntimeConfig): void {
    if (isAbsolute(config.executable) && !existsSync(config.executable)) {
      throw new Error("找不到 llama.cpp 可执行文件，请在设置中重新选择。");
    }
    if (
      config.embedding.modelMode === "local"
      && (!config.embedding.modelPath || !existsSync(config.embedding.modelPath))
    ) {
      throw new Error("找不到本地 Embedding GGUF 模型，请在设置中重新选择。");
    }
    if (
      config.embedding.modelMode === "huggingface"
      && config.embedding.hfRepo.trim().toLowerCase() !== MANAGED_EMBEDDING_MODEL.id.toLowerCase()
    ) {
      throw new Error(
        "当前只自动管理官方 Qwen3-Embedding-0.6B-Q8；其他模型请切换为本地 GGUF。",
      );
    }
  }

  private async verifyModelFile(
    path: string,
    signal: AbortSignal,
  ): Promise<VerifiedLocalModel> {
    const before = statSync(path);
    const sha256 = await this.hashModelFile(path, signal);
    const after = statSync(path);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error("Embedding GGUF 在校验期间发生变化，请重试。");
    }
    if (!/^[a-f0-9]{64}$/i.test(sha256)) {
      throw new Error("Embedding GGUF SHA-256 校验结果无效。");
    }
    return {
      path: normalizedLocalModelPath(path),
      size: after.size,
      modifiedAt: after.mtimeMs,
      sha256: sha256.toLowerCase(),
    };
  }

  private async launch(
    config: RuntimeConfig,
    resolvedModelPath: string | undefined,
    modelAlias: string,
    modelSha256: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<EmbeddingState> {
    if (generation !== this.generation || signal.aborted) return this.snapshot;
    const { command, args } = buildEmbeddingLlamaCommand(
      config,
      resolvedModelPath,
      modelAlias,
    );
    const modelPath = resolvedModelPath ?? displayedModelPath(config);
    this.publish({
      phase: "starting",
      modelPath,
      message: resolvedModelPath || config.embedding.modelMode === "local"
        ? "正在加载本地 Embedding GGUF 模型。"
        : "llama.cpp 正在准备远程 Embedding 模型。",
      download: undefined,
    });

    try {
      const child = this.spawnProcess(command, args, {
        cwd: isAbsolute(command) ? dirname(command) : undefined,
        env: { ...process.env },
        windowsHide: true,
        stdio: "pipe",
      }) as ChildProcessWithoutNullStreams;
      this.child = child;
      const handleLog = (buffer: Buffer): void => {
        if (generation !== this.generation || this.child !== child) return;
        const lastLog = buffer
          .toString("utf8")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .at(-1);
        if (lastLog) this.publish({ lastLog: diagnostic(lastLog) });
      };
      child.stdout.on("data", handleLog);
      child.stderr.on("data", handleLog);
      child.once("error", (error) => {
        if (generation !== this.generation || this.child !== child) return;
        if (child.pid === undefined || child.exitCode !== null) {
          this.child = null;
          this.handleUnexpectedExit(`无法启动 llama.cpp embedding 服务：${error.message}`);
          return;
        }
        this.publish({
          phase: "error",
          message: "Embedding runtime 进程错误。",
          error: `llama.cpp embedding 进程发生错误：${error.message}`,
          pid: child.pid,
        });
      });
      child.once("exit", (code, exitSignal) => {
        if (generation !== this.generation || this.child !== child) return;
        this.child = null;
        if (this.state.phase === "stopping" || this.state.phase === "stopped") return;
        this.handleUnexpectedExit(
          `llama.cpp embedding 服务已退出（${exitSignal ? `信号 ${exitSignal}` : `退出码 ${code ?? "未知"}`}）。`,
        );
      });
      return await this.waitUntilReady(
        config,
        modelAlias,
        resolvedModelPath ?? (config.embedding.modelMode === "local"
          ? config.embedding.modelPath
          : undefined),
        modelSha256,
        child,
        generation,
        signal,
      );
    } catch (error) {
      if (signal.aborted || generation !== this.generation) return this.snapshot;
      const child = this.child;
      return child
        ? this.failAfterTerminatingChild(child, message(error))
        : this.fail(message(error));
    }
  }

  private async waitUntilReady(
    config: RuntimeConfig,
    modelAlias: string,
    verifiedModelPath: string | undefined,
    modelSha256: string,
    child: ChildProcessWithoutNullStreams,
    generation: number,
    signal: AbortSignal,
  ): Promise<EmbeddingState> {
    const startedAt = Date.now();
    while (
      generation === this.generation
      && this.child === child
      && Date.now() - startedAt < this.readinessTimeoutMs
    ) {
      if (await this.isHealthy(this.healthTimeoutMs, signal)) {
        try {
          const dimension = await this.probeEmbeddingServer(
            signal,
            modelAlias,
            expectedDimension(config),
          );
          if (generation !== this.generation || this.child !== child || signal.aborted) {
            return this.snapshot;
          }
          if (verifiedModelPath) {
            const verified = await this.verifyModelFile(verifiedModelPath, signal);
            if (verified.sha256 !== modelSha256) {
              throw new Error(
                "Embedding GGUF 在服务启动期间发生变化，已拒绝使用该进程。",
              );
            }
            if (config.embedding.modelMode === "local") this.verifiedLocalModel = verified;
          }
          if (generation !== this.generation || this.child !== child || signal.aborted) {
            return this.snapshot;
          }
          return this.publish({
            phase: "ready",
            pid: child.pid,
            message: "本地 Qwen 向量模型已就绪。",
            embeddingDimension: dimension,
            error: undefined,
            download: undefined,
          });
        } catch (error) {
          if (signal.aborted || generation !== this.generation || this.child !== child) {
            return this.snapshot;
          }
          return this.failAfterTerminatingChild(child, message(error));
        }
      }
      await delay(this.readinessPollMs, signal);
    }
    if (signal.aborted || generation !== this.generation || this.child !== child) {
      return this.snapshot;
    }
    return this.failAfterTerminatingChild(
      child,
      "Embedding 模型在等待时间内未能就绪，请检查运行日志和可用内存。",
    );
  }

  private async isHealthy(timeoutMs: number, parentSignal: AbortSignal): Promise<boolean> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    parentSignal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (parentSignal.aborted) return false;
      const response = await this.fetchEmbedding(`${this.endpoint}/health`, {
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      parentSignal.removeEventListener("abort", onAbort);
    }
  }

  private async probeEmbeddingServer(
    signal: AbortSignal,
    expectedAlias: string,
    requiredDimension?: number,
  ): Promise<number> {
    const models = await this.fetchWithTimeout(`${this.endpoint}/v1/models`, {
      signal,
    });
    if (!models.ok) {
      throw new Error(`当前端口不是兼容的 llama.cpp 服务（/v1/models HTTP ${models.status}）。`);
    }
    const modelPayload = await models.json() as { data?: unknown };
    const aliases = Array.isArray(modelPayload.data)
      ? modelPayload.data.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const value = item as { id?: unknown; model?: unknown };
        return [value.id, value.model].filter((candidate): candidate is string =>
          typeof candidate === "string");
      })
      : [];
    if (!aliases.includes(expectedAlias)) {
      throw new Error(
        `端口 ${this.config.embedding.port} 已被其他服务占用，未找到当前模型标识 ${expectedAlias}。`,
      );
    }

    const [vector] = await this.requestEmbeddings(
      [formatEmbeddingQuery("验证本地知识检索服务")],
      signal,
      requiredDimension,
    );
    if (!vector) throw new Error("llama.cpp embedding 探针没有返回向量。");
    return vector.length;
  }

  private async embedTexts(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    if (this.state.phase !== "ready") throw new Error("Embedding runtime 尚未就绪。");
    const vectors: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += EMBEDDING_REQUEST_BATCH_SIZE) {
      if (signal?.aborted) throw abortError();
      const batch = texts.slice(offset, offset + EMBEDDING_REQUEST_BATCH_SIZE);
      vectors.push(...await this.requestEmbeddings(
        batch,
        signal,
        this.state.embeddingDimension,
      ));
    }
    return vectors;
  }

  private async requestEmbeddings(
    texts: readonly string[],
    signal?: AbortSignal,
    requiredDimension?: number,
  ): Promise<number[][]> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    this.requestControllers.add(controller);
    try {
      const response = await this.fetchEmbedding(`${this.endpoint}/v1/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.activeModelAlias,
          input: texts,
          encoding_format: "float",
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = diagnostic(await response.text());
        throw new Error(
          `llama.cpp /v1/embeddings HTTP ${response.status}${detail ? `：${detail}` : ""}`,
        );
      }
      return parseEmbeddingResponse(await response.json(), texts.length, requiredDimension);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      this.requestControllers.delete(controller);
    }
  }

  private async fetchWithTimeout(
    input: string,
    options: { signal: AbortSignal },
  ): Promise<Response> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) controller.abort();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await this.fetchEmbedding(input, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
    }
  }

  private enqueueEmbedding<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.requestQueue.then(operation, operation);
    this.requestQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private updateDownloadState(generation: number, download: ModelDownloadProgress): void {
    if (generation !== this.generation) return;
    const source = download.source === "modelscope" ? "ModelScope" : "Hugging Face";
    const amount = download.totalBytes
      ? `${formatBytes(download.receivedBytes)} / ${formatBytes(download.totalBytes)}`
      : formatBytes(download.receivedBytes);
    this.publish({
      phase: "downloading",
      message: download.percent === undefined
        ? `正在从 ${source} 下载 Embedding 模型。`
        : `正在从 ${source} 下载 Embedding 模型 · ${download.percent}%`,
      lastLog: amount,
      download,
    });
  }

  private handleUnexpectedExit(error: string): void {
    for (const controller of this.requestControllers) controller.abort();
    this.requestControllers.clear();
    this.fail(error);
  }

  private fail(error: string): EmbeddingState {
    return this.publish({
      phase: "error",
      message: "Embedding runtime 启动失败。",
      error,
      download: undefined,
      pid: undefined,
    });
  }

  private publish(patch: Partial<EmbeddingState>): EmbeddingState {
    this.state = {
      ...this.state,
      ...patch,
      enabled: this.config.embedding.enabled,
      endpoint: endpointFor(this.config),
      updatedAt: Date.now(),
    };
    this.emit("state", this.snapshot);
    return this.snapshot;
  }
}
