import { randomUUID } from "node:crypto";
import type {
  KnowledgeDocumentSummary,
  KnowledgeSearchResult,
} from "../shared/types";
import type {
  KnowledgeChunkEmbedding,
  KnowledgeEmbeddingStats,
  KnowledgeEmbeddingVector,
  PendingKnowledgeChunk,
} from "./knowledge-base-store";

const DEFAULT_BATCH_SIZE = 16;
const DEFAULT_RESULT_LIMIT = 4;
const MAX_RESULT_LIMIT = 64;
const DEFAULT_RRF_K = 60;
const DEFAULT_BUSY_SEARCH_TIMEOUT_MS = 5_000;

type Awaitable<T> = T | Promise<T>;

/** The narrow contract implemented by the local embedding runtime. */
export interface EmbeddingClient {
  ensureReady(): Promise<unknown>;
  embedQuery(text: string, signal?: AbortSignal): Promise<KnowledgeEmbeddingVector>;
  embedDocuments(
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly KnowledgeEmbeddingVector[]>;
  fingerprint(): string;
}

/** Accepted by the knowledge tool so synchronous lexical stores remain compatible. */
export interface KnowledgeSearchRetriever {
  listDocuments(): Awaitable<KnowledgeDocumentSummary[]>;
  search(query: string, limit?: number): Awaitable<KnowledgeSearchResult[]>;
}

export interface KnowledgeRetrievalStore {
  listDocuments(): KnowledgeDocumentSummary[];
  search(query: string, limit?: number): KnowledgeSearchResult[];
  listPendingEmbeddingChunks(fingerprint: string, limit?: number): PendingKnowledgeChunk[];
  listChunksForEmbeddingReindex(afterChunkId?: string, limit?: number): PendingKnowledgeChunk[];
  saveChunkEmbeddings(
    fingerprint: string,
    embeddings: readonly KnowledgeChunkEmbedding[],
  ): number;
  getEmbeddingStats(fingerprint: string): KnowledgeEmbeddingStats;
  clearEmbeddings(fingerprint?: string): number;
  replaceEmbeddingsFromStaging(
    stagingFingerprint: string,
    targetFingerprint: string,
  ): number;
  searchByEmbedding(
    embedding: KnowledgeEmbeddingVector,
    fingerprint: string,
    limit?: number,
  ): KnowledgeSearchResult[];
}

export interface KnowledgeIndexOptions {
  batchSize?: number;
  force?: boolean;
  maxBatches?: number;
  signal?: AbortSignal;
  onProgress?: (stats: KnowledgeEmbeddingStats) => void;
}

export interface KnowledgeRetrieverOptions {
  batchSize?: number;
  candidateMultiplier?: number;
  reciprocalRankConstant?: number;
  indexBatchBeforeSearch?: boolean;
  busySearchTimeoutMs?: number;
  onWarning?: (message: string) => void;
  onIndexProgress?: (stats: KnowledgeEmbeddingStats) => void;
}

/**
 * Adds persistent vector retrieval to the existing MiniSearch index. Indexing is
 * serialized in-process; SQLite remains the source of truth across restarts.
 */
export class KnowledgeRetriever implements KnowledgeSearchRetriever {
  private readonly batchSize: number;
  private readonly candidateMultiplier: number;
  private readonly reciprocalRankConstant: number;
  private readonly indexBatchBeforeSearch: boolean;
  private readonly busySearchTimeoutMs: number;
  private readonly onWarning: (message: string) => void;
  private readonly onIndexProgress: (stats: KnowledgeEmbeddingStats) => void;
  private indexingTail: Promise<void> = Promise.resolve();
  private pendingIndexOperations = 0;

  constructor(
    private readonly store: KnowledgeRetrievalStore,
    private readonly embeddingClient: EmbeddingClient,
    options: KnowledgeRetrieverOptions = {},
  ) {
    this.batchSize = clampInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, 1, 256);
    this.candidateMultiplier = clampInteger(options.candidateMultiplier ?? 4, 1, 16);
    this.reciprocalRankConstant = clampInteger(
      options.reciprocalRankConstant ?? DEFAULT_RRF_K,
      1,
      10_000,
    );
    this.indexBatchBeforeSearch = options.indexBatchBeforeSearch !== false;
    this.busySearchTimeoutMs = clampInteger(
      options.busySearchTimeoutMs ?? DEFAULT_BUSY_SEARCH_TIMEOUT_MS,
      10,
      120_000,
    );
    this.onWarning = options.onWarning ?? (() => {});
    this.onIndexProgress = options.onIndexProgress ?? (() => {});
  }

  listDocuments(): KnowledgeDocumentSummary[] {
    return this.store.listDocuments();
  }

  async indexPendingChunks(options: KnowledgeIndexOptions = {}): Promise<KnowledgeEmbeddingStats> {
    this.pendingIndexOperations += 1;
    const task = this.indexingTail.then(() => options.force
      ? this.runForcedReindex(options)
      : this.runIndexing(options));
    this.indexingTail = task.then(() => undefined, () => undefined);
    try {
      return await task;
    } finally {
      this.pendingIndexOperations = Math.max(0, this.pendingIndexOperations - 1);
    }
  }

  async search(query: string, limit = DEFAULT_RESULT_LIMIT): Promise<KnowledgeSearchResult[]> {
    const term = query.trim().slice(0, 500);
    if (!term) return [];
    const safeLimit = clampInteger(limit, 1, MAX_RESULT_LIMIT);
    const candidateLimit = Math.min(
      MAX_RESULT_LIMIT,
      Math.max(safeLimit, safeLimit * this.candidateMultiplier),
    );
    const lexicalResults = this.store.search(term, candidateLimit);
    const indexerBusy = this.pendingIndexOperations > 0;

    try {
      const vectorResults = await withAbortTimeout(
        this.busySearchTimeoutMs,
        async (signal) => {
          if (this.indexBatchBeforeSearch && !indexerBusy) {
            await this.indexPendingChunks({
              batchSize: this.batchSize,
              maxBatches: 1,
              signal,
            });
          }
          return this.searchByEmbedding(term, candidateLimit, signal);
        },
      );
      if (!vectorResults.length) return lexicalResults.slice(0, safeLimit);
      return reciprocalRankFusion(
        [lexicalResults, vectorResults],
        safeLimit,
        this.reciprocalRankConstant,
      );
    } catch (error) {
      this.onWarning(`知识库向量检索不可用，已退回词法检索：${errorMessage(error)}`);
      return lexicalResults.slice(0, safeLimit);
    }
  }

  private async searchByEmbedding(
    term: string,
    candidateLimit: number,
    signal?: AbortSignal,
  ): Promise<KnowledgeSearchResult[]> {
    await this.embeddingClient.ensureReady();
    throwIfAborted(signal);
    const fingerprint = this.embeddingClient.fingerprint();
    const queryEmbedding = await this.embeddingClient.embedQuery(term, signal);
    throwIfAborted(signal);
    if (this.embeddingClient.fingerprint() !== fingerprint) {
      throw new Error("Embedding 配置在查询期间发生变化，已丢弃本次向量结果。");
    }
    return this.store.searchByEmbedding(
      queryEmbedding,
      fingerprint,
      candidateLimit,
    );
  }

  private async runIndexing(options: KnowledgeIndexOptions): Promise<KnowledgeEmbeddingStats> {
    throwIfAborted(options.signal);
    await this.embeddingClient.ensureReady();
    throwIfAborted(options.signal);
    const fingerprint = this.embeddingClient.fingerprint();
    return this.runIndexingWithFingerprints(options, fingerprint, fingerprint);
  }

  private async runForcedReindex(
    options: KnowledgeIndexOptions,
  ): Promise<KnowledgeEmbeddingStats> {
    throwIfAborted(options.signal);
    await this.embeddingClient.ensureReady();
    throwIfAborted(options.signal);
    const fingerprint = this.embeddingClient.fingerprint();
    const stagingFingerprint = `staging:${randomUUID()}`;
    let switched = false;
    try {
      await this.runIndexingWithFingerprints(
        options,
        fingerprint,
        stagingFingerprint,
      );
      throwIfAborted(options.signal);
      if (this.embeddingClient.fingerprint() !== fingerprint) {
        throw new Error("Embedding 配置在索引切换前发生变化，已保留原向量索引。");
      }
      this.store.replaceEmbeddingsFromStaging(stagingFingerprint, fingerprint);
      switched = true;
      const stats = this.store.getEmbeddingStats(fingerprint);
      this.onIndexProgress(stats);
      options.onProgress?.(stats);
      return stats;
    } finally {
      try {
        this.store.clearEmbeddings(stagingFingerprint);
      } catch (error) {
        this.onWarning(`清理暂存向量失败：${errorMessage(error)}`);
      }
      if (!switched) {
        try {
          const activeStats = this.store.getEmbeddingStats(
            this.embeddingClient.fingerprint(),
          );
          this.onIndexProgress(activeStats);
          options.onProgress?.(activeStats);
        } catch (error) {
          this.onWarning(`恢复活动向量统计失败：${errorMessage(error)}`);
        }
      }
    }
  }

  private async runIndexingWithFingerprints(
    options: KnowledgeIndexOptions,
    modelFingerprint: string,
    storageFingerprint: string,
  ): Promise<KnowledgeEmbeddingStats> {
    const batchSize = clampInteger(options.batchSize ?? this.batchSize, 1, 256);
    const maxBatches = options.maxBatches === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor(options.maxBatches));
    let completedBatches = 0;
    let forceCursor = "";
    let forcing = options.force === true;

    while (completedBatches < maxBatches) {
      throwIfAborted(options.signal);
      const chunks = forcing
        ? this.store.listChunksForEmbeddingReindex(forceCursor, batchSize)
        : this.store.listPendingEmbeddingChunks(storageFingerprint, batchSize);
      if (!chunks.length) {
        if (forcing) {
          forcing = false;
          continue;
        }
        break;
      }
      const vectors = await this.embeddingClient.embedDocuments(
        chunks.map((chunk) => chunk.text),
        options.signal,
      );
      throwIfAborted(options.signal);
      if (this.embeddingClient.fingerprint() !== modelFingerprint) {
        throw new Error("Embedding 配置在索引期间发生变化，已丢弃本批向量结果。");
      }
      if (vectors.length !== chunks.length) {
        throw new Error(
          `embedding 服务返回 ${vectors.length} 个向量，但本批包含 ${chunks.length} 个片段。`,
        );
      }
      this.store.saveChunkEmbeddings(
        storageFingerprint,
        chunks.map((chunk, index) => ({
          chunkId: chunk.chunkId,
          expectedText: chunk.text,
          embedding: vectors[index]!,
        })),
      );
      if (forcing) forceCursor = chunks.at(-1)!.chunkId;
      completedBatches += 1;
      const stats = this.store.getEmbeddingStats(storageFingerprint);
      this.onIndexProgress(stats);
      options.onProgress?.(stats);
    }

    const stats = this.store.getEmbeddingStats(storageFingerprint);
    if (completedBatches === 0) {
      this.onIndexProgress(stats);
      options.onProgress?.(stats);
    }
    return stats;
  }
}

export function reciprocalRankFusion(
  rankings: readonly (readonly KnowledgeSearchResult[])[],
  limit: number,
  rankConstant = DEFAULT_RRF_K,
): KnowledgeSearchResult[] {
  const safeLimit = clampInteger(limit, 1, MAX_RESULT_LIMIT);
  const safeRankConstant = clampInteger(rankConstant, 1, 10_000);
  const fused = new Map<string, {
    result: KnowledgeSearchResult;
    score: number;
    bestRank: number;
  }>();

  for (const ranking of rankings) {
    const seen = new Set<string>();
    for (const [index, result] of ranking.entries()) {
      if (seen.has(result.chunkId)) continue;
      seen.add(result.chunkId);
      const rank = index + 1;
      const contribution = 1 / (safeRankConstant + rank);
      const current = fused.get(result.chunkId);
      if (current) {
        current.score += contribution;
        current.bestRank = Math.min(current.bestRank, rank);
      } else {
        fused.set(result.chunkId, {
          result,
          score: contribution,
          bestRank: rank,
        });
      }
    }
  }

  return [...fused.values()]
    .sort((left, right) => (
      right.score - left.score
      || left.bestRank - right.bestRank
      || left.result.chunkId.localeCompare(right.result.chunkId)
    ))
    .slice(0, safeLimit)
    .map(({ result, score }) => ({ ...result, score }));
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  throw new DOMException("Aborted", "AbortError");
}

async function withAbortTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`知识库语义检索在 ${timeoutMs} ms 内未完成，已返回词法结果。`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
