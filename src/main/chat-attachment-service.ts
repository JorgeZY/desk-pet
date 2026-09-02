import { dialog, nativeImage, type BrowserWindow } from "electron";
import { promises as fs } from "node:fs";
import { basename, extname } from "node:path";
import type {
  ChatDocument,
  ChatImage,
  ChatImageMimeType,
  FilePickResult,
} from "../shared/types";
import {
  CHAT_TEXT_EXTENSIONS,
  MAX_CHAT_DOCUMENTS,
  MAX_CHAT_DOCUMENT_TOTAL_BYTES,
  MAX_CHAT_DOCUMENT_TOTAL_CHARACTERS,
  readChatDocument,
} from "./chat-documents";
import { MAX_KNOWLEDGE_DOCUMENT_CHARACTERS } from "./knowledge-base-store";

const MAX_KNOWLEDGE_DOCUMENTS_PER_IMPORT = 10;
const MAX_KNOWLEDGE_DOCUMENT_TOTAL_BYTES = 50 * 1024 * 1024;

const CHAT_IMAGE_MIME_TYPES: Record<string, ChatImageMimeType> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export class ChatAttachmentService {
  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  async pickFile(
    title: string,
    filters: Electron.FileFilter[],
  ): Promise<FilePickResult | null> {
    const result = await this.open({ title, properties: ["openFile"], filters });
    if (result.canceled || !result.filePaths[0]) return null;
    const path = result.filePaths[0];
    return { path, name: basename(path) };
  }

  async pickImages(): Promise<ChatImage[]> {
    const result = await this.open({
      title: "选择要发送给视觉模型的图片",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "图片", extensions: ["jpg", "jpeg", "png", "webp", "gif"] }],
    });
    if (result.canceled) return [];
    if (result.filePaths.length > 4) throw new Error("一次最多选择 4 张图片。");

    const images: ChatImage[] = [];
    let totalBytes = 0;
    for (const path of result.filePaths) {
      const name = basename(path);
      const mimeType = CHAT_IMAGE_MIME_TYPES[extname(path).toLowerCase()];
      if (!mimeType) throw new Error(`不支持图片格式：${name}`);
      const stats = await fs.stat(path);
      if (stats.size > 10 * 1024 * 1024) throw new Error(`图片 ${name} 超过 10 MB。`);
      totalBytes += stats.size;
      if (totalBytes > 10 * 1024 * 1024) throw new Error("所选图片合计不能超过 10 MB。");

      let preview = nativeImage.createFromPath(path);
      if (preview.isEmpty()) throw new Error(`无法读取图片：${name}`);
      const size = preview.getSize();
      const scale = Math.min(1, 512 / size.width, 512 / size.height);
      if (scale < 1) {
        preview = preview.resize({
          width: Math.max(1, Math.round(size.width * scale)),
          height: Math.max(1, Math.round(size.height * scale)),
          quality: "good",
        });
      }
      images.push({ path, name, mimeType, previewUrl: preview.toDataURL() });
    }
    return images;
  }

  async pickDocuments(): Promise<ChatDocument[]> {
    const result = await this.open({
      title: "选择要加入对话的文本或 PDF 文档",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "文本与 PDF", extensions: [...CHAT_TEXT_EXTENSIONS, "pdf"] }],
    });
    if (result.canceled) return [];
    if (result.filePaths.length > MAX_CHAT_DOCUMENTS) {
      throw new Error(`一次最多选择 ${MAX_CHAT_DOCUMENTS} 个文档。`);
    }

    let totalBytes = 0;
    for (const path of result.filePaths) totalBytes += (await fs.stat(path)).size;
    if (totalBytes > MAX_CHAT_DOCUMENT_TOTAL_BYTES) {
      throw new Error("所选文档合计不能超过 20 MB。");
    }

    const perDocumentLimit = Math.max(
      1,
      Math.floor(MAX_CHAT_DOCUMENT_TOTAL_CHARACTERS / Math.max(1, result.filePaths.length)),
    );
    const documents: ChatDocument[] = [];
    for (const path of result.filePaths) {
      documents.push(await readChatDocument(path, perDocumentLimit));
    }
    return documents;
  }

  async pickKnowledgeDocuments(): Promise<ChatDocument[]> {
    const result = await this.open({
      title: "选择要加入本地知识库的文本或 PDF 文档",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "文本与 PDF", extensions: [...CHAT_TEXT_EXTENSIONS, "pdf"] }],
    });
    if (result.canceled) return [];
    if (result.filePaths.length > MAX_KNOWLEDGE_DOCUMENTS_PER_IMPORT) {
      throw new Error(`一次最多导入 ${MAX_KNOWLEDGE_DOCUMENTS_PER_IMPORT} 个知识库文档。`);
    }

    let totalBytes = 0;
    for (const path of result.filePaths) totalBytes += (await fs.stat(path)).size;
    if (totalBytes > MAX_KNOWLEDGE_DOCUMENT_TOTAL_BYTES) {
      throw new Error("一次导入的知识库文档合计不能超过 50 MB。");
    }

    const documents: ChatDocument[] = [];
    for (const path of result.filePaths) {
      documents.push(await readChatDocument(path, MAX_KNOWLEDGE_DOCUMENT_CHARACTERS));
    }
    return documents;
  }

  private open(options: Electron.OpenDialogOptions) {
    const window = this.getWindow();
    return window
      ? dialog.showOpenDialog(window, options)
      : dialog.showOpenDialog(options);
  }
}
