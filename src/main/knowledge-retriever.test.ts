import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeSearchResult } from "../shared/types";
import { KnowledgeBaseStore } from "./knowledge-base-store";
import {
  KnowledgeRetriever,
  reciprocalRankFusion,
  type EmbeddingClient,
  type KnowledgeRetrievalStore,
} from "./knowledge-retriever";

const stores: KnowledgeBaseStore[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (stores.length) stores.pop()?.close();
  while (temporaryDirectories.length) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("KnowledgeRetriever indexing", () => {
  it("backfills pending chunks in bounded batches", async () => {
    const directory = mkdtempSync(join(tmpdir(), "desktop-pet-retriever-"));
    temporaryDirectories.push(directory);
    const store = new KnowledgeBaseStore(join(directory, "knowledge.sqlite"), {
      createId: () => "document-1",
    });
    stores.push(store);
    store.upsertDocument({
      path: "D:\\docs\\batch.txt",
      name: "batch.txt",
      mimeType: "text/plain",
      text: "batch indexing content. ".repeat(180),
      characterCount: 4_320,
    });
    const initial = store.getEmbeddingStats("model-a");
    expect(initial.pendingChunkCount).toBeGreaterThan(2);

    const embedDocuments = vi.fn(async (texts: readonly string[]) => (
      texts.map((_text, index) => [1, index + 1])
    ));
    const progress: number[] = [];
    const globalProgress: number[] = [];
    const retriever = new KnowledgeRetriever(store, embeddingClient({ embedDocuments }), {
      batchSize: 2,
      indexBatchBeforeSearch: false,
      onIndexProgress: (current) => globalProgress.push(current.indexedChunkCount),
    });
    const stats = await retriever.indexPendingChunks({
      onProgress: (current) => progress.push(current.indexedChunkCount),
    });

    expect(stats).toMatchObject({
      indexedChunkCount: initial.totalChunkCount,
      pendingChunkCount: 0,
      embeddingDimension: 2,
    });
    expect(embedDocuments).toHaveBeenCalledTimes(Math.ceil(initial.totalChunkCount / 2));
    expect(progress.at(-1)).toBe(initial.totalChunkCount);
    expect(globalProgress.at(-1)).toBe(initial.totalChunkCount);
  });

  it("leaves a batch pending when the embedding service returns the wrong count", async () => {
    const directory = mkdtempSync(join(tmpdir(), "desktop-pet-retriever-count-"));
    temporaryDirectories.push(directory);
    const store = new KnowledgeBaseStore(join(directory, "knowledge.sqlite"), {
      createId: () => "document-1",
    });
    stores.push(store);
    store.upsertDocument({
      path: "D:\\docs\\count.txt",
      name: "count.txt",
      mimeType: "text/plain",
      text: "需要完整返回每一个片段的向量。",
      characterCount: 16,
    });
    const retriever = new KnowledgeRetriever(store, embeddingClient({
      embedDocuments: vi.fn(async () => []),
    }));

    await expect(retriever.indexPendingChunks()).rejects.toThrow("本批包含 1 个片段");
    expect(store.getEmbeddingStats("model-a").indexedChunkCount).toBe(0);
  });

  it("preserves existing vectors when a forced reindex fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "desktop-pet-retriever-force-"));
    temporaryDirectories.push(directory);
    const store = new KnowledgeBaseStore(join(directory, "knowledge.sqlite"), {
      createId: () => "document-1",
    });
    stores.push(store);
    store.upsertDocument({
      path: "D:\\docs\\force.txt",
      name: "force.txt",
      mimeType: "text/plain",
      text: "已存在的向量在重建失败时必须继续可用。",
      characterCount: 20,
    });
    const [chunk] = store.listPendingEmbeddingChunks("model-a");
    store.saveChunkEmbeddings("model-a", [{
      chunkId: chunk!.chunkId,
      expectedText: chunk!.text,
      embedding: [1, 0],
    }]);
    const retriever = new KnowledgeRetriever(store, embeddingClient({
      embedDocuments: vi.fn(async () => {
        throw new Error("embedding server stopped");
      }),
    }));

    await expect(retriever.indexPendingChunks({ force: true }))
      .rejects.toThrow("embedding server stopped");
    expect(store.getEmbeddingStats("model-a")).toMatchObject({
      indexedChunkCount: 1,
      pendingChunkCount: 0,
    });
    expect(store.searchByEmbedding([1, 0], "model-a")).toEqual([
      expect.objectContaining({ chunkId: chunk!.chunkId }),
    ]);
  });

  it("keeps the active index atomic when a later forced-reindex batch fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "desktop-pet-retriever-staging-"));
    temporaryDirectories.push(directory);
    const store = new KnowledgeBaseStore(join(directory, "knowledge.sqlite"), {
      createId: () => "document-1",
    });
    stores.push(store);
    store.upsertDocument({
      path: "D:\\docs\\staging.txt",
      name: "staging.txt",
      mimeType: "text/plain",
      text: "staged reindex content. ".repeat(180),
      characterCount: 4_320,
    });
    const chunks = store.listPendingEmbeddingChunks("model-a", 20);
    expect(chunks.length).toBeGreaterThan(1);
    store.saveChunkEmbeddings("model-a", chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      expectedText: chunk.text,
      embedding: [1, 0],
    })));
    let batch = 0;
    const progress: Array<{ fingerprint: string; indexedChunkCount: number }> = [];
    const retriever = new KnowledgeRetriever(store, embeddingClient({
      embedDocuments: vi.fn(async () => {
        batch += 1;
        if (batch === 1) return [[0, 1]];
        throw new Error("second staged batch failed");
      }),
    }), {
      onIndexProgress: (stats) => progress.push(stats),
    });

    await expect(retriever.indexPendingChunks({ force: true, batchSize: 1 }))
      .rejects.toThrow("second staged batch failed");
    expect(store.getEmbeddingStats("model-a")).toMatchObject({
      indexedChunkCount: chunks.length,
      pendingChunkCount: 0,
    });
    expect(store.searchByEmbedding([1, 0], "model-a", chunks.length))
      .toSatisfy((results: KnowledgeSearchResult[]) =>
        results.length === chunks.length && results.every((result) => result.score === 1));
    expect(progress.at(-1)).toMatchObject({
      fingerprint: "model-a",
      indexedChunkCount: chunks.length,
    });
  });

  it("atomically switches a complete forced reindex into the active fingerprint", async () => {
    const directory = mkdtempSync(join(tmpdir(), "desktop-pet-retriever-switch-"));
    temporaryDirectories.push(directory);
    const store = new KnowledgeBaseStore(join(directory, "knowledge.sqlite"), {
      createId: () => "document-1",
    });
    stores.push(store);
    store.upsertDocument({
      path: "D:\\docs\\switch.txt",
      name: "switch.txt",
      mimeType: "text/plain",
      text: "complete staged reindex. ".repeat(150),
      characterCount: 3_750,
    });
    const chunks = store.listPendingEmbeddingChunks("model-a", 20);
    store.saveChunkEmbeddings("model-a", chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      expectedText: chunk.text,
      embedding: [1, 0],
    })));
    const retriever = new KnowledgeRetriever(store, embeddingClient({
      embedDocuments: async (texts) => texts.map(() => [0, 1]),
    }));

    await expect(retriever.indexPendingChunks({ force: true, batchSize: 1 }))
      .resolves.toMatchObject({
        fingerprint: "model-a",
        indexedChunkCount: chunks.length,
        pendingChunkCount: 0,
      });
    const switched = store.searchByEmbedding([0, 1], "model-a", chunks.length);
    expect(switched).toHaveLength(chunks.length);
    expect(switched.every((result) => result.score === 1)).toBe(true);
  });

  it("restores statistics for the current model when a forced reindex becomes stale", async () => {
    let fingerprint = "model-a";
    const progress: string[] = [];
    const retriever = new KnowledgeRetriever(
      retrievalStore(
        { lexical: [], vector: [] },
        {
          listChunksForEmbeddingReindex: (afterChunkId) => afterChunkId ? [] : [{
            chunkId: "chunk-1",
            documentId: "document-1",
            documentName: "knowledge.md",
            position: 0,
            text: "stale model content",
          }],
        },
      ),
      embeddingClient({
        fingerprint: () => fingerprint,
        embedDocuments: async () => {
          fingerprint = "model-b";
          throw new Error("model changed during force reindex");
        },
      }),
      { onIndexProgress: (stats) => progress.push(stats.fingerprint) },
    );

    await expect(retriever.indexPendingChunks({ force: true }))
      .rejects.toThrow("model changed during force reindex");
    expect(progress.at(-1)).toBe("model-b");
  });
});

describe("KnowledgeRetriever hybrid search", () => {
  it("pre-indexes exactly one batch before searching when the indexer is idle", async () => {
    const lexical = [searchResult("lexical", 10)];
    const vector = [searchResult("vector", 0.9)];
    const listPendingEmbeddingChunks = vi.fn(() => [{
      chunkId: "pending-1",
      documentId: "document-1",
      documentName: "knowledge.md",
      position: 0,
      text: "pending knowledge",
    }]);
    const saveChunkEmbeddings = vi.fn(() => 1);
    const embedDocuments = vi.fn(async () => [[1, 0]]);
    const retriever = new KnowledgeRetriever(
      retrievalStore(
        { lexical, vector },
        { listPendingEmbeddingChunks, saveChunkEmbeddings },
      ),
      embeddingClient({ embedDocuments }),
    );

    await retriever.search("semantic question", 2);

    expect(listPendingEmbeddingChunks).toHaveBeenCalledTimes(1);
    expect(embedDocuments).toHaveBeenCalledTimes(1);
    expect(saveChunkEmbeddings).toHaveBeenCalledWith("model-a", [{
      chunkId: "pending-1",
      expectedText: "pending knowledge",
      embedding: [1, 0],
    }]);
  });

  it("does not queue search behind active indexing and bounds the vector attempt", async () => {
    const lexical = [searchResult("lexical-first", 10)];
    const indexingGate = deferred<readonly (readonly number[])[]>();
    const listPendingEmbeddingChunks = vi.fn(() => [{
      chunkId: "pending-1",
      documentId: "document-1",
      documentName: "knowledge.md",
      position: 0,
      text: "pending knowledge",
    }]);
    const embedDocuments = vi.fn(() => indexingGate.promise);
    const embedQuery = vi.fn((_text: string, signal?: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        const abort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      }));
    const warnings: string[] = [];
    const retriever = new KnowledgeRetriever(
      retrievalStore(
        { lexical, vector: [] },
        { listPendingEmbeddingChunks, saveChunkEmbeddings: () => 1 },
      ),
      embeddingClient({ embedDocuments, embedQuery }),
      {
        busySearchTimeoutMs: 20,
        onWarning: (warning) => warnings.push(warning),
      },
    );
    let indexingSettled = false;
    const indexing = retriever.indexPendingChunks({ maxBatches: 1 }).finally(() => {
      indexingSettled = true;
    });
    await vi.waitFor(() => expect(embedDocuments).toHaveBeenCalledTimes(1));

    await expect(retriever.search("available lexical result", 1)).resolves.toEqual(lexical);

    expect(indexingSettled).toBe(false);
    expect(listPendingEmbeddingChunks).toHaveBeenCalledTimes(1);
    expect(embedQuery).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual([expect.stringContaining("已返回词法结果")]);
    indexingGate.resolve([[1, 0]]);
    await indexing;
  });

  it("bounds the entire semantic branch when the idle pre-index batch stalls", async () => {
    const lexical = [searchResult("lexical-first", 10)];
    const indexingGate = deferred<readonly (readonly number[])[]>();
    const saveChunkEmbeddings = vi.fn(() => 1);
    const warnings: string[] = [];
    const retriever = new KnowledgeRetriever(
      retrievalStore(
        { lexical, vector: [] },
        {
          listPendingEmbeddingChunks: () => [{
            chunkId: "pending-1",
            documentId: "document-1",
            documentName: "knowledge.md",
            position: 0,
            text: "pending knowledge",
          }],
          saveChunkEmbeddings,
        },
      ),
      embeddingClient({ embedDocuments: () => indexingGate.promise }),
      {
        busySearchTimeoutMs: 20,
        onWarning: (warning) => warnings.push(warning),
      },
    );

    await expect(retriever.search("available lexical result", 1)).resolves.toEqual(lexical);
    expect(warnings).toEqual([expect.stringContaining("已返回词法结果")]);

    indexingGate.resolve([[1, 0]]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saveChunkEmbeddings).not.toHaveBeenCalled();
  });

  it("uses reciprocal-rank fusion so agreement outranks a single-list winner", async () => {
    const lexical = [searchResult("lexical-first", 10), searchResult("shared", 9)];
    const vector = [searchResult("shared", 0.95), searchResult("vector-only", 0.9)];
    const retriever = new KnowledgeRetriever(
      retrievalStore({ lexical, vector }),
      embeddingClient(),
      { indexBatchBeforeSearch: false },
    );

    const results = await retriever.search("semantic question", 3);
    expect(results.map((result) => result.chunkId)).toEqual([
      "shared",
      "lexical-first",
      "vector-only",
    ]);
    expect(results[0]!.score).toBeCloseTo(1 / 62 + 1 / 61);
  });

  it("reliably falls back to lexical results when vectors are unavailable", async () => {
    const lexical = [searchResult("lexical-first", 10), searchResult("lexical-second", 8)];
    const warnings: string[] = [];
    const retriever = new KnowledgeRetriever(
      retrievalStore({ lexical, vector: [] }),
      embeddingClient({
        ensureReady: vi.fn(async () => {
          throw new Error("embedding server offline");
        }),
      }),
      {
        indexBatchBeforeSearch: false,
        onWarning: (warning) => warnings.push(warning),
      },
    );

    await expect(retriever.search("offline query", 1)).resolves.toEqual([lexical[0]]);
    expect(warnings).toEqual([expect.stringContaining("已退回词法检索")]);
  });
});

describe("reciprocalRankFusion", () => {
  it("deduplicates a chunk within each ranking", () => {
    const duplicate = searchResult("duplicate", 1);
    const [result] = reciprocalRankFusion([[duplicate, duplicate]], 1, 10);
    expect(result?.score).toBeCloseTo(1 / 11);
  });
});

function embeddingClient(overrides: Partial<EmbeddingClient> = {}): EmbeddingClient {
  return {
    ensureReady: async () => {},
    embedQuery: async () => [1, 0],
    embedDocuments: async (texts) => texts.map(() => [1, 0]),
    fingerprint: () => "model-a",
    ...overrides,
  };
}

function retrievalStore(options: {
  lexical: KnowledgeSearchResult[];
  vector: KnowledgeSearchResult[];
}, overrides: Partial<KnowledgeRetrievalStore> = {}): KnowledgeRetrievalStore {
  return {
    listDocuments: () => [],
    search: () => options.lexical,
    listPendingEmbeddingChunks: () => [],
    listChunksForEmbeddingReindex: () => [],
    saveChunkEmbeddings: () => 0,
    getEmbeddingStats: (fingerprint) => ({
      fingerprint,
      totalChunkCount: 0,
      indexedChunkCount: 0,
      pendingChunkCount: 0,
    }),
    clearEmbeddings: () => 0,
    replaceEmbeddingsFromStaging: () => 0,
    searchByEmbedding: () => options.vector,
    ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function searchResult(chunkId: string, score: number): KnowledgeSearchResult {
  return {
    chunkId,
    documentId: "document-1",
    documentName: "knowledge.md",
    position: 0,
    score,
    text: chunkId,
  };
}
