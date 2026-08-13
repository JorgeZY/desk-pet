import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ChatConversation, ChatImage, ChatMessage } from "../shared/types";

const MAX_CONVERSATIONS = 30;
const RECOMMENDATION_CONVERSATIONS = 5;
const RECOMMENDATION_MESSAGES = 6;
// Keep background prompt ingestion short so it yields quickly when the user
// returns to the composer, especially on CPU-only llama.cpp installations.
const RECOMMENDATION_CHARACTER_LIMIT = 1600;

interface ConversationRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  message_count: number;
}

interface MessageRow {
  id: string;
  role: ChatMessage["role"];
  content: string;
  reasoning: string | null;
  images_json: string | null;
  created_at: number;
}

export interface RecommendationContext {
  fingerprint: string;
  transcript: string;
}

interface ChatHistoryStoreOptions {
  now?: () => number;
  createId?: () => string;
}

function parseImages(value: string | null): ChatImage[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as ChatImage[];
    return Array.isArray(parsed) && parsed.length ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function serializeImages(images?: ChatImage[]): string | null {
  if (!images?.length) return null;
  return JSON.stringify(images.map(({ path, name, mimeType }) => ({ path, name, mimeType })));
}

function conversationFromRow(row: ConversationRow): ChatConversation {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count,
  };
}

function titleForMessages(messages: ChatMessage[]): string {
  const firstText = messages.find(
    (message) => message.role === "user" && message.content.trim(),
  )?.content.trim();
  if (firstText) return firstText.slice(0, 30);
  if (messages.some((message) => message.role === "user" && message.images?.length)) {
    return "图片对话";
  }
  return "新对话";
}

export class ChatHistoryStore {
  private readonly database: DatabaseSync;
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(filePath: string, options: ChatHistoryStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.database = new DatabaseSync(filePath);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        reasoning TEXT,
        images_json TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(conversation_id, position)
      );
      CREATE INDEX IF NOT EXISTS messages_conversation_position
        ON messages(conversation_id, position);
      CREATE TABLE IF NOT EXISTS recommendation_cache (
        fingerprint TEXT PRIMARY KEY,
        recommendations_json TEXT NOT NULL,
        generated_at INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.database.close();
  }

  listConversations(): ChatConversation[] {
    const rows = this.database.prepare(`
      SELECT c.id, c.title, c.created_at, c.updated_at, COUNT(m.id) AS message_count
      FROM conversations c
      LEFT JOIN messages m ON m.conversation_id = c.id
      GROUP BY c.id
      ORDER BY c.updated_at DESC, c.created_at DESC, c.id DESC
    `).all() as unknown as ConversationRow[];
    return rows.map(conversationFromRow);
  }

  createConversation(): ChatConversation {
    const id = this.createId();
    const timestamp = this.now();
    this.database.prepare(`
      INSERT INTO conversations (id, title, created_at, updated_at)
      VALUES (?, '新对话', ?, ?)
    `).run(id, timestamp, timestamp);
    this.pruneConversations(id);
    return { id, title: "新对话", createdAt: timestamp, updatedAt: timestamp, messageCount: 0 };
  }

  loadMessages(conversationId: string): ChatMessage[] {
    this.requireConversation(conversationId);
    const rows = this.database.prepare(`
      SELECT id, role, content, reasoning, images_json, created_at
      FROM messages
      WHERE conversation_id = ?
      ORDER BY position ASC
    `).all(conversationId) as unknown as MessageRow[];
    return rows.map((row) => {
      const images = parseImages(row.images_json);
      return {
        id: row.id,
        role: row.role,
        content: row.content,
        ...(row.reasoning ? { reasoning: row.reasoning } : {}),
        ...(images ? { images } : {}),
        createdAt: row.created_at,
      };
    });
  }

  saveMessages(conversationId: string, messages: ChatMessage[]): ChatConversation {
    const current = this.requireConversation(conversationId);
    const nextUpdatedAt = Math.max(this.now(), current.updated_at + 1);
    const insert = this.database.prepare(`
      INSERT INTO messages (
        id, conversation_id, position, role, content, reasoning, images_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM messages WHERE conversation_id = ?").run(conversationId);
      messages.forEach((message, position) => {
        insert.run(
          message.id,
          conversationId,
          position,
          message.role,
          message.content,
          message.reasoning ?? null,
          serializeImages(message.images),
          message.createdAt,
        );
      });
      this.database.prepare(`
        UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?
      `).run(titleForMessages(messages), nextUpdatedAt, conversationId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    return {
      id: conversationId,
      title: titleForMessages(messages),
      createdAt: current.created_at,
      updatedAt: nextUpdatedAt,
      messageCount: messages.length,
    };
  }

  deleteConversation(conversationId: string): void {
    this.database.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId);
  }

  getRecommendationContext(): RecommendationContext | null {
    const conversations = this.listConversations()
      .filter((conversation) => conversation.messageCount > 0)
      .slice(0, RECOMMENDATION_CONVERSATIONS);
    if (!conversations.length) return null;

    const transcriptParts: string[] = [];
    let remaining = RECOMMENDATION_CHARACTER_LIMIT;
    for (const [conversationIndex, conversation] of conversations.entries()) {
      if (remaining <= 0) break;
      const messages = this.database.prepare(`
        SELECT role, content FROM (
          SELECT role, content, position
          FROM messages
          WHERE conversation_id = ? AND trim(content) <> ''
          ORDER BY position DESC
          LIMIT ?
        ) ORDER BY position ASC
      `).all(conversation.id, RECOMMENDATION_MESSAGES) as unknown as Array<{
        role: ChatMessage["role"];
        content: string;
      }>;
      const section = [
        `近期会话 ${conversationIndex + 1}`,
        ...messages.map((message) => `${message.role === "user" ? "用户" : "助手"}：${message.content}`),
      ].join("\n");
      const clipped = section.slice(0, remaining);
      if (clipped) transcriptParts.push(clipped);
      remaining -= clipped.length;
    }
    if (!transcriptParts.length) return null;

    const fingerprintSource = conversations
      .map((conversation) => `${conversation.id}:${conversation.updatedAt}`)
      .join("|");
    return {
      fingerprint: createHash("sha256").update(fingerprintSource).digest("hex"),
      transcript: transcriptParts.join("\n\n").slice(0, RECOMMENDATION_CHARACTER_LIMIT),
    };
  }

  getCachedRecommendations(fingerprint: string): string[] | null {
    const row = this.database.prepare(`
      SELECT recommendations_json FROM recommendation_cache WHERE fingerprint = ?
    `).get(fingerprint) as { recommendations_json: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.recommendations_json) as unknown;
      return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  cacheRecommendations(fingerprint: string, recommendations: string[]): void {
    this.database.prepare(`
      INSERT INTO recommendation_cache (fingerprint, recommendations_json, generated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(fingerprint) DO UPDATE SET
        recommendations_json = excluded.recommendations_json,
        generated_at = excluded.generated_at
    `).run(fingerprint, JSON.stringify(recommendations), this.now());
    this.database.prepare(`
      DELETE FROM recommendation_cache
      WHERE fingerprint NOT IN (
        SELECT fingerprint FROM recommendation_cache ORDER BY generated_at DESC LIMIT 10
      )
    `).run();
  }

  private requireConversation(conversationId: string): ConversationRow {
    const row = this.database.prepare(`
      SELECT c.id, c.title, c.created_at, c.updated_at,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
      FROM conversations c WHERE c.id = ?
    `).get(conversationId) as unknown as ConversationRow | undefined;
    if (!row) throw new Error("找不到指定的聊天会话。");
    return row;
  }

  private pruneConversations(currentConversationId: string): void {
    const stale = this.listConversations()
      .filter((conversation) => conversation.id !== currentConversationId)
      .slice(MAX_CONVERSATIONS - 1);
    const remove = this.database.prepare("DELETE FROM conversations WHERE id = ?");
    for (const conversation of stale) remove.run(conversation.id);
  }
}
