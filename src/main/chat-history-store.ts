import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  ChatConversation,
  ChatDocument,
  ChatImage,
  ChatMessage,
  ChatToolCall,
} from "../shared/types";

const MAX_CONVERSATIONS = 30;

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
  documents_json: string | null;
  tool_calls_json: string | null;
  created_at: number;
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

function parseJsonArray<T>(value: string | null): T[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as T[];
    return Array.isArray(parsed) && parsed.length ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function serializeDocuments(documents?: ChatDocument[]): string | null {
  return documents?.length ? JSON.stringify(documents) : null;
}

function serializeToolCalls(toolCalls?: ChatToolCall[]): string | null {
  return toolCalls?.length ? JSON.stringify(toolCalls) : null;
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
  if (messages.some((message) => message.role === "user" && message.documents?.length)) {
    return "文档对话";
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
        documents_json TEXT,
        tool_calls_json TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(conversation_id, position)
      );
      CREATE INDEX IF NOT EXISTS messages_conversation_position
        ON messages(conversation_id, position);
    `);
    this.ensureMessageColumn("documents_json", "TEXT");
    this.ensureMessageColumn("tool_calls_json", "TEXT");
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
      SELECT id, role, content, reasoning, images_json, documents_json, tool_calls_json, created_at
      FROM messages
      WHERE conversation_id = ?
      ORDER BY position ASC
    `).all(conversationId) as unknown as MessageRow[];
    return rows.map((row) => {
      const images = parseImages(row.images_json);
      const documents = parseJsonArray<ChatDocument>(row.documents_json);
      const toolCalls = parseJsonArray<ChatToolCall>(row.tool_calls_json);
      return {
        id: row.id,
        role: row.role,
        content: row.content,
        ...(row.reasoning ? { reasoning: row.reasoning } : {}),
        ...(images ? { images } : {}),
        ...(documents ? { documents } : {}),
        ...(toolCalls ? { toolCalls } : {}),
        createdAt: row.created_at,
      };
    });
  }

  saveMessages(conversationId: string, messages: ChatMessage[]): ChatConversation {
    const current = this.requireConversation(conversationId);
    const nextUpdatedAt = Math.max(this.now(), current.updated_at + 1);
    const insert = this.database.prepare(`
      INSERT INTO messages (
        id, conversation_id, position, role, content, reasoning, images_json,
        documents_json, tool_calls_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          serializeDocuments(message.documents),
          serializeToolCalls(message.toolCalls),
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

  private requireConversation(conversationId: string): ConversationRow {
    const row = this.database.prepare(`
      SELECT c.id, c.title, c.created_at, c.updated_at,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
      FROM conversations c WHERE c.id = ?
    `).get(conversationId) as unknown as ConversationRow | undefined;
    if (!row) throw new Error("找不到指定的聊天会话。");
    return row;
  }

  private ensureMessageColumn(name: "documents_json" | "tool_calls_json", type: "TEXT"): void {
    const columns = this.database.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) {
      this.database.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
    }
  }

  private pruneConversations(currentConversationId: string): void {
    const stale = this.listConversations()
      .filter((conversation) => conversation.id !== currentConversationId)
      .slice(MAX_CONVERSATIONS - 1);
    const remove = this.database.prepare("DELETE FROM conversations WHERE id = ?");
    for (const conversation of stale) remove.run(conversation.id);
  }
}
