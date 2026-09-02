import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  chunkKnowledgeText,
  KnowledgeBaseStore,
  tokenizeKnowledgeText,
} from "./knowledge-base-store";

const stores: KnowledgeBaseStore[] = [];
const temporaryDirectories: string[] = [];

function createStore(): KnowledgeBaseStore {
  const directory = mkdtempSync(join(tmpdir(), "desktop-pet-knowledge-base-"));
  temporaryDirectories.push(directory);
  const store = new KnowledgeBaseStore(join(directory, "knowledge.sqlite"), {
    now: () => 123,
    createId: () => "document-1",
  });
  stores.push(store);
  return store;
}

function closeStore(store: KnowledgeBaseStore): void {
  store.close();
  stores.splice(stores.indexOf(store), 1);
}

afterEach(() => {
  while (stores.length) stores.pop()?.close();
  while (temporaryDirectories.length) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("knowledge text processing", () => {
  it("creates bounded overlapping chunks", () => {
    const chunks = chunkKnowledgeText("第一段。\n" + "机器人材料实验。".repeat(80), 240, 40);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.length <= 240)).toBe(true);
  });

  it("tokenizes English terms and Chinese character n-grams", () => {
    expect(tokenizeKnowledgeText("Robot 外壳材料")).toEqual(expect.arrayContaining([
      "robot",
      "外壳",
      "材料",
    ]));
  });
});

describe("KnowledgeBaseStore", () => {
  it("persists, replaces, searches, and deletes local documents", () => {
    const store = createStore();
    store.upsertDocument({
      path: "D:\\docs\\robot.md",
      name: "robot.md",
      mimeType: "text/plain",
      text: "机器人外壳使用碳纤维复合材料，结构件使用铝合金。",
      characterCount: 28,
    });

    expect(store.listDocuments()).toEqual([
      expect.objectContaining({ id: "document-1", name: "robot.md", chunkCount: 1 }),
    ]);
    expect(store.search("外壳材料")).toEqual([
      expect.objectContaining({ documentName: "robot.md", position: 0 }),
    ]);

    store.upsertDocument({
      path: "D:\\docs\\robot.md",
      name: "robot.md",
      mimeType: "text/plain",
      text: "机器人外壳改用镁合金。",
      characterCount: 11,
    });
    expect(store.search("碳纤维")).toEqual([]);
    expect(store.search("镁合金")[0]?.text).toContain("镁合金");

    store.deleteDocument("document-1");
    expect(store.listDocuments()).toEqual([]);
    expect(store.search("镁合金")).toEqual([]);
  });

  it("rebuilds its search index from the persisted SQLite database", () => {
    const directory = mkdtempSync(join(tmpdir(), "desktop-pet-knowledge-reopen-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "knowledge.sqlite");
    const first = new KnowledgeBaseStore(databasePath, { createId: () => "persisted-document" });
    stores.push(first);
    first.upsertDocument({
      path: "D:\\docs\\长期任务.md",
      name: "长期任务.md",
      mimeType: "text/plain",
      text: "任务状态保存在 SQLite，重新启动后继续检索。",
      characterCount: 26,
    });
    closeStore(first);

    const reopened = new KnowledgeBaseStore(databasePath);
    stores.push(reopened);
    expect(reopened.listDocuments()[0]).toMatchObject({ id: "persisted-document" });
    expect(reopened.search("重新启动")[0]?.documentName).toBe("长期任务.md");
  });

  it("removes orphaned staging vectors when the store reopens", () => {
    const directory = mkdtempSync(join(tmpdir(), "desktop-pet-knowledge-staging-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "knowledge.sqlite");
    const first = new KnowledgeBaseStore(databasePath, { createId: () => "staged-document" });
    stores.push(first);
    first.upsertDocument({
      path: "D:\\docs\\staged.txt",
      name: "staged.txt",
      mimeType: "text/plain",
      text: "崩溃后应清理未切换的暂存向量。",
      characterCount: 18,
    });
    const [chunk] = first.listPendingEmbeddingChunks("staging:orphan");
    first.saveChunkEmbeddings("staging:orphan", [{
      chunkId: chunk!.chunkId,
      expectedText: chunk!.text,
      embedding: [1, 0],
    }]);
    closeStore(first);

    const reopened = new KnowledgeBaseStore(databasePath);
    stores.push(reopened);
    expect(reopened.getEmbeddingStats("staging:orphan")).toMatchObject({
      indexedChunkCount: 0,
      pendingChunkCount: 1,
    });
  });

  it("persists Float32 embeddings and exact cosine search across restarts", () => {
    const directory = mkdtempSync(join(tmpdir(), "desktop-pet-knowledge-vectors-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "knowledge.sqlite");
    const first = new KnowledgeBaseStore(databasePath, { createId: () => "vector-document" });
    stores.push(first);
    first.upsertDocument({
      path: "D:\\docs\\vectors.txt",
      name: "vectors.txt",
      mimeType: "text/plain",
      text: "alpha ".repeat(500),
      characterCount: 3_000,
    });
    const pending = first.listPendingEmbeddingChunks("model-a", 20);
    expect(pending.length).toBeGreaterThan(1);
    expect(first.saveChunkEmbeddings("model-a", pending.map((chunk, index) => ({
      chunkId: chunk.chunkId,
      expectedText: chunk.text,
      embedding: index === 0
        ? new Float32Array([100, 0])
        : index === 1 ? [1, 1] : [0, 1],
    })))).toBe(pending.length);
    expect(first.getEmbeddingStats("model-a")).toMatchObject({
      totalChunkCount: pending.length,
      indexedChunkCount: pending.length,
      pendingChunkCount: 0,
      embeddingDimension: 2,
    });
    closeStore(first);

    const reopened = new KnowledgeBaseStore(databasePath);
    stores.push(reopened);
    expect(reopened.listPendingEmbeddingChunks("model-a")).toEqual([]);
    const [bestMatch] = reopened.searchByEmbedding([1, 1], "model-a", 2);
    expect(bestMatch).toMatchObject({
      chunkId: pending[1]?.chunkId,
    });
    expect(bestMatch?.score).toBeCloseTo(1);
  });

  it("treats a changed fingerprint as pending and can clear stale vectors", () => {
    const store = createStore();
    store.upsertDocument({
      path: "D:\\docs\\fingerprint.md",
      name: "fingerprint.md",
      mimeType: "text/plain",
      text: "向量模型版本发生变化时需要重新索引。",
      characterCount: 20,
    });
    const [chunk] = store.listPendingEmbeddingChunks("model-a");
    expect(chunk).toBeDefined();
    store.saveChunkEmbeddings("model-a", [{
      chunkId: chunk!.chunkId,
      expectedText: chunk!.text,
      embedding: [1, 0],
    }]);

    expect(store.getEmbeddingStats("model-a").pendingChunkCount).toBe(0);
    expect(store.getEmbeddingStats("model-b")).toMatchObject({
      indexedChunkCount: 0,
      pendingChunkCount: 1,
    });
    expect(store.searchByEmbedding([1, 0], "model-b")).toEqual([]);
    expect(store.clearEmbeddings("model-a")).toBe(1);
    expect(store.getEmbeddingStats("model-a").pendingChunkCount).toBe(1);
  });

  it("rejects inconsistent bulk dimensions without partially saving a batch", () => {
    const store = createStore();
    store.upsertDocument({
      path: "D:\\docs\\dimensions.txt",
      name: "dimensions.txt",
      mimeType: "text/plain",
      text: "dimension ".repeat(300),
      characterCount: 3_000,
    });
    const pending = store.listPendingEmbeddingChunks("model-a", 20);
    expect(pending.length).toBeGreaterThan(1);
    expect(() => store.saveChunkEmbeddings("model-a", [
      { chunkId: pending[0]!.chunkId, expectedText: pending[0]!.text, embedding: [1, 0] },
      { chunkId: pending[1]!.chunkId, expectedText: pending[1]!.text, embedding: [1, 0, 0] },
    ])).toThrow("维度必须一致");
    expect(store.getEmbeddingStats("model-a").indexedChunkCount).toBe(0);
  });

  it("invalidates a chunk embedding when its source document is replaced", () => {
    const store = createStore();
    const document = {
      path: "D:\\docs\\replace.txt",
      name: "replace.txt",
      mimeType: "text/plain" as const,
      text: "旧内容使用铝合金。",
      characterCount: 10,
    };
    store.upsertDocument(document);
    const [chunk] = store.listPendingEmbeddingChunks("model-a");
    store.saveChunkEmbeddings("model-a", [{
      chunkId: chunk!.chunkId,
      expectedText: chunk!.text,
      embedding: [1, 0],
    }]);
    expect(store.getEmbeddingStats("model-a").pendingChunkCount).toBe(0);

    store.upsertDocument({
      ...document,
      text: "新内容改为碳纤维。",
    });
    expect(store.getEmbeddingStats("model-a")).toMatchObject({
      indexedChunkCount: 0,
      pendingChunkCount: 1,
    });
    expect(store.searchByEmbedding([1, 0], "model-a")).toEqual([]);
  });

  it("does not attach a stale vector after the same chunk ID is replaced", () => {
    const store = createStore();
    const document = {
      path: "D:\\docs\\replace-during-embedding.txt",
      name: "replace-during-embedding.txt",
      mimeType: "text/plain" as const,
      text: "旧内容使用铝合金。",
      characterCount: 10,
    };
    store.upsertDocument(document);
    const [staleChunk] = store.listPendingEmbeddingChunks("model-a");

    store.upsertDocument({
      ...document,
      text: "新内容改为碳纤维。",
    });

    expect(store.saveChunkEmbeddings("model-a", [{
      chunkId: staleChunk!.chunkId,
      expectedText: staleChunk!.text,
      embedding: [1, 0],
    }])).toBe(0);
    expect(store.getEmbeddingStats("model-a")).toMatchObject({
      indexedChunkCount: 0,
      pendingChunkCount: 1,
    });
    expect(store.searchByEmbedding([1, 0], "model-a")).toEqual([]);
  });

  it("treats Windows paths case-insensitively when replacing an index", () => {
    const store = createStore();
    store.upsertDocument({
      path: "D:\\Docs\\Robot.md",
      name: "Robot.md",
      mimeType: "text/plain",
      text: "旧版本使用铝合金。",
      characterCount: 10,
    });
    store.upsertDocument({
      path: "d:\\docs\\robot.md",
      name: "robot.md",
      mimeType: "text/plain",
      text: "新版本使用碳纤维。",
      characterCount: 10,
    });

    expect(store.listDocuments()).toHaveLength(1);
    expect(store.search("碳纤维")[0]?.documentName).toBe("robot.md");
  });
});
