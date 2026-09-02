import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import MiniSearch from "minisearch";
import type {
  ChatDocument,
  KnowledgeDocumentSummary,
  KnowledgeSearchResult,
} from "../shared/types";

export const KNOWLEDGE_CHUNK_CHARACTERS = 1_200;
export const KNOWLEDGE_CHUNK_OVERLAP = 160;
export const MAX_KNOWLEDGE_DOCUMENT_CHARACTERS = 400_000;

interface KnowledgeDocumentRow {
  id: string;
  path: string;
  name: string;
  mime_type: ChatDocument["mimeType"];
  character_count: number;
  chunk_count: number;
  created_at: number;
  updated_at: number;
}

interface KnowledgeChunkRow {
  id: string;
  document_id: string;
  document_name: string;
  position: number;
  content: string;
}

interface KnowledgeEmbeddingRow extends KnowledgeChunkRow {
  embedding: Uint8Array;
  magnitude: number;
}

interface KnowledgeEmbeddingStatsRow {
  total_chunk_count: number;
  indexed_chunk_count: number;
  minimum_dimension: number | null;
  maximum_dimension: number | null;
}

interface IndexedKnowledgeChunk {
  id: string;
  documentId: string;
  documentName: string;
  position: number;
  text: string;
}

interface KnowledgeBaseStoreOptions {
  now?: () => number;
  createId?: () => string;
}

export type KnowledgeEmbeddingVector = readonly number[] | Float32Array;

export interface PendingKnowledgeChunk {
  chunkId: string;
  documentId: string;
  documentName: string;
  position: number;
  text: string;
}

export interface KnowledgeChunkEmbedding {
  chunkId: string;
  expectedText: string;
  embedding: KnowledgeEmbeddingVector;
}

export interface KnowledgeEmbeddingStats {
  fingerprint: string;
  totalChunkCount: number;
  indexedChunkCount: number;
  pendingChunkCount: number;
  embeddingDimension?: number;
}

function documentFromRow(row: KnowledgeDocumentRow): KnowledgeDocumentSummary {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    mimeType: row.mime_type,
    characterCount: row.character_count,
    chunkCount: row.chunk_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function tokenizeKnowledgeText(text: string): string[] {
  const groups = text.normalize("NFKC").toLocaleLowerCase().match(
    /\p{Script=Han}+|[\p{L}\p{N}_-]+/gu,
  ) ?? [];
  const tokens: string[] = [];
  for (const group of groups) {
    if (!/^\p{Script=Han}+$/u.test(group)) {
      tokens.push(group);
      continue;
    }
    const characters = [...group];
    tokens.push(...characters);
    if (characters.length <= 12) tokens.push(group);
    for (let index = 0; index + 1 < characters.length; index += 1) {
      tokens.push(`${characters[index]}${characters[index + 1]}`);
    }
  }
  return tokens;
}

export function chunkKnowledgeText(
  text: string,
  chunkCharacters = KNOWLEDGE_CHUNK_CHARACTERS,
  overlapCharacters = KNOWLEDGE_CHUNK_OVERLAP,
): string[] {
  const normalized = text.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  const size = Math.max(200, Math.floor(chunkCharacters));
  const overlap = Math.min(Math.max(0, Math.floor(overlapCharacters)), Math.floor(size / 3));
  const chunks: string[] = [];
  let start = 0;

  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + size);
    if (end < normalized.length) {
      const searchStart = Math.max(start + Math.floor(size * 0.65), end - 260);
      const tail = normalized.slice(searchStart, end);
      const boundary = Math.max(
        tail.lastIndexOf("\n"),
        tail.lastIndexOf("。"),
        tail.lastIndexOf("！"),
        tail.lastIndexOf("？"),
        tail.lastIndexOf(". "),
      );
      if (boundary >= 0) end = searchStart + boundary + 1;
    }
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

function createSearchIndex(): MiniSearch<IndexedKnowledgeChunk> {
  return new MiniSearch<IndexedKnowledgeChunk>({
    fields: ["documentName", "text"],
    storeFields: ["documentId", "documentName", "position", "text"],
    tokenize: tokenizeKnowledgeText,
    searchOptions: {
      boost: { documentName: 2 },
      combineWith: "OR",
      prefix: true,
    },
  });
}

export class KnowledgeBaseStore {
  private readonly database: DatabaseSync;
  private readonly now: () => number;
  private readonly createId: () => string;
  private searchIndex = createSearchIndex();

  constructor(filePath: string, options: KnowledgeBaseStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.database = new DatabaseSync(filePath);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_documents (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        character_count INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        content TEXT NOT NULL,
        UNIQUE(document_id, position)
      );
      CREATE INDEX IF NOT EXISTS knowledge_chunks_document_position
        ON knowledge_chunks(document_id, position);
      CREATE UNIQUE INDEX IF NOT EXISTS knowledge_documents_path_nocase
        ON knowledge_documents(path COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS knowledge_chunk_embeddings (
        chunk_id TEXT NOT NULL REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL,
        dimension INTEGER NOT NULL CHECK(dimension > 0),
        embedding BLOB NOT NULL,
        magnitude REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(chunk_id, fingerprint)
      );
      CREATE INDEX IF NOT EXISTS knowledge_chunk_embeddings_fingerprint
        ON knowledge_chunk_embeddings(fingerprint, dimension);
      DELETE FROM knowledge_chunk_embeddings WHERE fingerprint LIKE 'staging:%';
    `);
    this.rebuildSearchIndex();
  }

  close(): void {
    this.database.close();
  }

  listDocuments(): KnowledgeDocumentSummary[] {
    const rows = this.database.prepare(`
      SELECT id, path, name, mime_type, character_count, chunk_count, created_at, updated_at
      FROM knowledge_documents
      ORDER BY updated_at DESC, name COLLATE NOCASE ASC
    `).all() as unknown as KnowledgeDocumentRow[];
    return rows.map(documentFromRow);
  }

  upsertDocument(document: ChatDocument): KnowledgeDocumentSummary {
    const text = document.text.trim();
    if (!text) throw new Error(`文档 ${document.name} 没有可索引的文本。`);
    if (document.characterCount > MAX_KNOWLEDGE_DOCUMENT_CHARACTERS || text.length > MAX_KNOWLEDGE_DOCUMENT_CHARACTERS) {
      throw new Error(`文档 ${document.name} 超过本地知识库 400,000 字符限制。`);
    }
    const chunks = chunkKnowledgeText(text);
    if (!chunks.length) throw new Error(`文档 ${document.name} 没有可索引的文本。`);

    const existing = this.database.prepare(`
      SELECT id, created_at FROM knowledge_documents WHERE path = ? COLLATE NOCASE
    `).get(document.path) as { id: string; created_at: number } | undefined;
    const id = existing?.id ?? this.createId();
    const timestamp = this.now();

    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database.prepare(`
        INSERT INTO knowledge_documents (
          id, path, name, mime_type, character_count, chunk_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          name = excluded.name,
          mime_type = excluded.mime_type,
          character_count = excluded.character_count,
          chunk_count = excluded.chunk_count,
          updated_at = excluded.updated_at
      `).run(
        id,
        document.path,
        document.name,
        document.mimeType,
        document.characterCount,
        chunks.length,
        existing?.created_at ?? timestamp,
        timestamp,
      );
      this.database.prepare("DELETE FROM knowledge_chunks WHERE document_id = ?").run(id);
      const insertChunk = this.database.prepare(`
        INSERT INTO knowledge_chunks (id, document_id, position, content)
        VALUES (?, ?, ?, ?)
      `);
      for (const [position, content] of chunks.entries()) {
        insertChunk.run(`${id}:${position}`, id, position, content);
      }
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
    this.rebuildSearchIndex();
    return this.listDocuments().find((item) => item.id === id)!;
  }

  deleteDocument(id: string): void {
    const safeId = id.trim();
    if (!safeId || safeId.length > 128) throw new Error("知识库文档 ID 无效。");
    this.database.prepare("DELETE FROM knowledge_documents WHERE id = ?").run(safeId);
    this.rebuildSearchIndex();
  }

  search(query: string, limit = 4): KnowledgeSearchResult[] {
    const term = query.trim().slice(0, 500);
    if (!term) return [];
    const safeLimit = Math.min(64, Math.max(1, Math.round(limit)));
    return this.searchIndex.search(term, { fuzzy: term.length >= 5 ? 0.15 : false })
      .slice(0, safeLimit)
      .map((result) => ({
        chunkId: String(result.id),
        documentId: String(result.documentId),
        documentName: String(result.documentName),
        position: Number(result.position),
        score: result.score,
        text: String(result.text),
      }));
  }

  listPendingEmbeddingChunks(fingerprint: string, limit = 32): PendingKnowledgeChunk[] {
    const safeFingerprint = validateEmbeddingFingerprint(fingerprint);
    const safeLimit = Math.min(256, Math.max(1, Math.round(limit)));
    const rows = this.database.prepare(`
      SELECT
        c.id,
        c.document_id,
        d.name AS document_name,
        c.position,
        c.content
      FROM knowledge_chunks c
      JOIN knowledge_documents d ON d.id = c.document_id
      LEFT JOIN knowledge_chunk_embeddings e
        ON e.chunk_id = c.id AND e.fingerprint = ?
      WHERE e.chunk_id IS NULL
      ORDER BY d.updated_at DESC, c.position ASC
      LIMIT ?
    `).all(safeFingerprint, safeLimit) as unknown as KnowledgeChunkRow[];
    return rows.map(chunkFromRow);
  }

  listChunksForEmbeddingReindex(afterChunkId = "", limit = 32): PendingKnowledgeChunk[] {
    const safeAfterChunkId = afterChunkId ? validateChunkId(afterChunkId) : "";
    const safeLimit = Math.min(256, Math.max(1, Math.round(limit)));
    const rows = this.database.prepare(`
      SELECT
        c.id,
        c.document_id,
        d.name AS document_name,
        c.position,
        c.content
      FROM knowledge_chunks c
      JOIN knowledge_documents d ON d.id = c.document_id
      WHERE c.id > ?
      ORDER BY c.id ASC
      LIMIT ?
    `).all(safeAfterChunkId, safeLimit) as unknown as KnowledgeChunkRow[];
    return rows.map(chunkFromRow);
  }

  saveChunkEmbeddings(
    fingerprint: string,
    embeddings: readonly KnowledgeChunkEmbedding[],
  ): number {
    const safeFingerprint = validateEmbeddingFingerprint(fingerprint);
    if (!embeddings.length) return 0;
    const seenChunkIds = new Set<string>();
    const encoded = embeddings.map((item) => {
      const chunkId = validateChunkId(item.chunkId);
      const expectedText = validateExpectedChunkText(item.expectedText);
      if (seenChunkIds.has(chunkId)) {
        throw new Error(`批量向量中包含重复的知识片段 ID：${chunkId}`);
      }
      seenChunkIds.add(chunkId);
      return { chunkId, expectedText, ...encodeEmbedding(item.embedding) };
    });
    const dimension = encoded[0]!.dimension;
    if (encoded.some((item) => item.dimension !== dimension)) {
      throw new Error("同一批知识向量的维度必须一致。");
    }
    const existing = this.database.prepare(`
      SELECT dimension
      FROM knowledge_chunk_embeddings
      WHERE fingerprint = ?
      LIMIT 1
    `).get(safeFingerprint) as { dimension: number } | undefined;
    if (existing && existing.dimension !== dimension) {
      throw new Error(
        `知识向量 fingerprint 已使用 ${existing.dimension} 维，不能写入 ${dimension} 维向量。`,
      );
    }

    const save = this.database.prepare(`
      INSERT INTO knowledge_chunk_embeddings (
        chunk_id, fingerprint, dimension, embedding, magnitude, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM knowledge_chunks WHERE id = ? AND content = ?
      )
      ON CONFLICT(chunk_id, fingerprint) DO UPDATE SET
        dimension = excluded.dimension,
        embedding = excluded.embedding,
        magnitude = excluded.magnitude,
        updated_at = excluded.updated_at
    `);
    let saved = 0;
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const timestamp = this.now();
      for (const item of encoded) {
        const result = save.run(
          item.chunkId,
          safeFingerprint,
          item.dimension,
          item.bytes,
          item.magnitude,
          timestamp,
          item.chunkId,
          item.expectedText,
        );
        saved += Number(result.changes);
      }
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
    return saved;
  }

  getEmbeddingStats(fingerprint: string): KnowledgeEmbeddingStats {
    const safeFingerprint = validateEmbeddingFingerprint(fingerprint);
    const row = this.database.prepare(`
      SELECT
        COUNT(c.id) AS total_chunk_count,
        COUNT(e.chunk_id) AS indexed_chunk_count,
        MIN(e.dimension) AS minimum_dimension,
        MAX(e.dimension) AS maximum_dimension
      FROM knowledge_chunks c
      LEFT JOIN knowledge_chunk_embeddings e
        ON e.chunk_id = c.id AND e.fingerprint = ?
    `).get(safeFingerprint) as unknown as KnowledgeEmbeddingStatsRow;
    const totalChunkCount = Number(row.total_chunk_count);
    const indexedChunkCount = Number(row.indexed_chunk_count);
    const hasConsistentDimension = row.minimum_dimension !== null
      && row.minimum_dimension === row.maximum_dimension;
    return {
      fingerprint: safeFingerprint,
      totalChunkCount,
      indexedChunkCount,
      pendingChunkCount: Math.max(0, totalChunkCount - indexedChunkCount),
      ...(hasConsistentDimension ? { embeddingDimension: Number(row.minimum_dimension) } : {}),
    };
  }

  clearEmbeddings(fingerprint?: string): number {
    const result = fingerprint === undefined
      ? this.database.prepare("DELETE FROM knowledge_chunk_embeddings").run()
      : this.database.prepare(`
          DELETE FROM knowledge_chunk_embeddings WHERE fingerprint = ?
        `).run(validateEmbeddingFingerprint(fingerprint));
    return Number(result.changes);
  }

  replaceEmbeddingsFromStaging(
    stagingFingerprint: string,
    targetFingerprint: string,
  ): number {
    const safeStagingFingerprint = validateEmbeddingFingerprint(stagingFingerprint);
    const safeTargetFingerprint = validateEmbeddingFingerprint(targetFingerprint);
    if (safeStagingFingerprint === safeTargetFingerprint) {
      throw new Error("暂存向量 fingerprint 不能与目标 fingerprint 相同。");
    }

    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const coverage = this.database.prepare(`
        SELECT
          COUNT(c.id) AS total_chunk_count,
          COUNT(e.chunk_id) AS indexed_chunk_count,
          COUNT(DISTINCT e.dimension) AS dimension_count
        FROM knowledge_chunks c
        LEFT JOIN knowledge_chunk_embeddings e
          ON e.chunk_id = c.id AND e.fingerprint = ?
      `).get(safeStagingFingerprint) as unknown as {
        total_chunk_count: number;
        indexed_chunk_count: number;
        dimension_count: number;
      };
      if (Number(coverage.total_chunk_count) !== Number(coverage.indexed_chunk_count)) {
        throw new Error("暂存向量索引不完整，已保留原向量索引。");
      }
      if (Number(coverage.dimension_count) > 1) {
        throw new Error("暂存向量索引维度不一致，已保留原向量索引。");
      }

      this.database.prepare(`
        DELETE FROM knowledge_chunk_embeddings WHERE fingerprint = ?
      `).run(safeTargetFingerprint);
      const inserted = this.database.prepare(`
        INSERT INTO knowledge_chunk_embeddings (
          chunk_id, fingerprint, dimension, embedding, magnitude, updated_at
        )
        SELECT chunk_id, ?, dimension, embedding, magnitude, updated_at
        FROM knowledge_chunk_embeddings
        WHERE fingerprint = ?
      `).run(safeTargetFingerprint, safeStagingFingerprint);
      this.database.prepare(`
        DELETE FROM knowledge_chunk_embeddings WHERE fingerprint = ?
      `).run(safeStagingFingerprint);
      this.database.exec("COMMIT;");
      return Number(inserted.changes);
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  searchByEmbedding(
    embedding: KnowledgeEmbeddingVector,
    fingerprint: string,
    limit = 8,
  ): KnowledgeSearchResult[] {
    const safeFingerprint = validateEmbeddingFingerprint(fingerprint);
    const query = normalizeEmbeddingInput(embedding);
    const queryMagnitude = vectorMagnitude(query);
    if (queryMagnitude === 0) throw new Error("查询向量不能为零向量。");
    const safeLimit = Math.min(64, Math.max(1, Math.round(limit)));
    const rows = this.database.prepare(`
      SELECT
        c.id,
        c.document_id,
        d.name AS document_name,
        c.position,
        c.content,
        e.embedding,
        e.magnitude
      FROM knowledge_chunk_embeddings e
      JOIN knowledge_chunks c ON c.id = e.chunk_id
      JOIN knowledge_documents d ON d.id = c.document_id
      WHERE e.fingerprint = ? AND e.dimension = ?
    `).all(safeFingerprint, query.length) as unknown as KnowledgeEmbeddingRow[];

    return rows.flatMap((row): KnowledgeSearchResult[] => {
      if (!Number.isFinite(row.magnitude) || row.magnitude <= 0) return [];
      const stored = decodeEmbedding(row.embedding, query.length);
      let dotProduct = 0;
      for (let index = 0; index < query.length; index += 1) {
        dotProduct += query[index]! * stored[index]!;
      }
      const cosine = dotProduct / (queryMagnitude * row.magnitude);
      if (!Number.isFinite(cosine)) return [];
      return [{
        chunkId: row.id,
        documentId: row.document_id,
        documentName: row.document_name,
        position: row.position,
        score: Math.max(-1, Math.min(1, cosine)),
        text: row.content,
      }];
    }).sort((left, right) => right.score - left.score || left.chunkId.localeCompare(right.chunkId))
      .slice(0, safeLimit);
  }

  private rebuildSearchIndex(): void {
    const rows = this.database.prepare(`
      SELECT
        c.id,
        c.document_id,
        d.name AS document_name,
        c.position,
        c.content
      FROM knowledge_chunks c
      JOIN knowledge_documents d ON d.id = c.document_id
      ORDER BY d.updated_at DESC, c.position ASC
    `).all() as unknown as KnowledgeChunkRow[];
    this.searchIndex = createSearchIndex();
    this.searchIndex.addAll(rows.map((row) => ({
      id: row.id,
      documentId: row.document_id,
      documentName: row.document_name,
      position: row.position,
      text: row.content,
    })));
  }
}

function chunkFromRow(row: KnowledgeChunkRow): PendingKnowledgeChunk {
  return {
    chunkId: row.id,
    documentId: row.document_id,
    documentName: row.document_name,
    position: row.position,
    text: row.content,
  };
}

function validateEmbeddingFingerprint(fingerprint: string): string {
  const safeFingerprint = fingerprint.trim();
  if (!safeFingerprint || safeFingerprint.length > 512) {
    throw new Error("知识向量 fingerprint 无效。");
  }
  return safeFingerprint;
}

function validateChunkId(chunkId: string): string {
  const safeChunkId = chunkId.trim();
  if (!safeChunkId || safeChunkId.length > 256) throw new Error("知识片段 ID 无效。");
  return safeChunkId;
}

function validateExpectedChunkText(text: string): string {
  if (typeof text !== "string" || !text || text.length > KNOWLEDGE_CHUNK_CHARACTERS) {
    throw new Error("知识片段原文无效。");
  }
  return text;
}

function normalizeEmbeddingInput(embedding: KnowledgeEmbeddingVector): Float32Array {
  if (!embedding.length) throw new Error("知识向量不能为空。");
  const normalized = new Float32Array(embedding.length);
  for (let index = 0; index < embedding.length; index += 1) {
    const value = Number(embedding[index]);
    if (!Number.isFinite(value)) throw new Error("知识向量只能包含有限数值。");
    normalized[index] = value;
  }
  return normalized;
}

function encodeEmbedding(embedding: KnowledgeEmbeddingVector): {
  bytes: Uint8Array;
  dimension: number;
  magnitude: number;
} {
  const normalized = normalizeEmbeddingInput(embedding);
  const bytes = Buffer.allocUnsafe(normalized.length * Float32Array.BYTES_PER_ELEMENT);
  for (let index = 0; index < normalized.length; index += 1) {
    bytes.writeFloatLE(normalized[index]!, index * Float32Array.BYTES_PER_ELEMENT);
  }
  const magnitude = vectorMagnitude(normalized);
  if (magnitude === 0) throw new Error("知识向量不能为零向量。");
  return {
    bytes,
    dimension: normalized.length,
    magnitude,
  };
}

function decodeEmbedding(bytes: Uint8Array, dimension: number): Float32Array {
  const expectedByteLength = dimension * Float32Array.BYTES_PER_ELEMENT;
  if (bytes.byteLength !== expectedByteLength) throw new Error("知识向量数据已损坏。");
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const embedding = new Float32Array(dimension);
  for (let index = 0; index < dimension; index += 1) {
    embedding[index] = buffer.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT);
  }
  return embedding;
}

function vectorMagnitude(embedding: Float32Array): number {
  let squaredMagnitude = 0;
  for (const value of embedding) squaredMagnitude += value * value;
  return Math.sqrt(squaredMagnitude);
}
