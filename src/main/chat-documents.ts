import { promises as fs } from "node:fs";
import { basename, extname } from "node:path";
import { PDFParse } from "pdf-parse";
import type { ChatDocument, ChatDocumentMimeType } from "../shared/types";

export const MAX_CHAT_DOCUMENTS = 5;
export const MAX_CHAT_DOCUMENT_BYTES = 8 * 1024 * 1024;
export const MAX_CHAT_DOCUMENT_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAX_CHAT_DOCUMENT_TOTAL_CHARACTERS = 48_000;

export const CHAT_TEXT_EXTENSIONS = [
  "txt",
  "md",
  "csv",
  "json",
  "log",
  "yaml",
  "yml",
  "xml",
  "html",
  "css",
  "js",
  "jsx",
  "ts",
  "tsx",
  "py",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
  "rs",
  "go",
  "sql",
  "sh",
  "ps1",
] as const;

const CHAT_TEXT_EXTENSION_SET = new Set(CHAT_TEXT_EXTENSIONS.map((extension) => `.${extension}`));

function mimeTypeForPath(path: string): ChatDocumentMimeType | null {
  const extension = extname(path).toLowerCase();
  if (extension === ".pdf") return "application/pdf";
  if (CHAT_TEXT_EXTENSION_SET.has(extension)) return "text/plain";
  return null;
}

function normalizeDocumentText(text: string): string {
  return text.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim();
}

async function extractPdfText(path: string): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(await fs.readFile(path)) });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

export async function readChatDocument(
  path: string,
  characterLimit = MAX_CHAT_DOCUMENT_TOTAL_CHARACTERS,
): Promise<ChatDocument> {
  const name = basename(path);
  const mimeType = mimeTypeForPath(path);
  if (!mimeType) throw new Error(`不支持文档格式：${name}`);

  const stats = await fs.stat(path);
  if (stats.size > MAX_CHAT_DOCUMENT_BYTES) {
    throw new Error(`文档 ${name} 超过 8 MB。`);
  }

  const rawText = mimeType === "application/pdf"
    ? await extractPdfText(path)
    : await fs.readFile(path, "utf8");
  const normalized = normalizeDocumentText(rawText);
  if (!normalized) {
    throw new Error(
      mimeType === "application/pdf"
        ? `PDF ${name} 没有可提取的文本；当前暂不对扫描图片执行 OCR。`
        : `文档 ${name} 没有可读取的文本。`,
    );
  }

  const safeLimit = Math.max(1, characterLimit);
  const truncated = normalized.length > safeLimit;
  return {
    path,
    name,
    mimeType,
    text: truncated ? normalized.slice(0, safeLimit) : normalized,
    characterCount: normalized.length,
    ...(truncated ? { truncated: true } : {}),
  };
}
