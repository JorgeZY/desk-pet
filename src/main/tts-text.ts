/**
 * Text cleaning and sentence segmentation for local TTS.
 *
 * llama.cpp replies arrive as streaming deltas and often contain Markdown.
 * This module turns the raw stream into speakable sentence-sized segments:
 * code blocks are dropped, Markdown decorations are stripped, and long
 * sentences are split so synthesis stays snappy on CPU.
 */

const SENTENCE_END = /[。！？!?；;…]|\.{3,}/gu;
const MAX_SENTENCE_LENGTH = 120;

const FENCE_PATTERN = /^(\s*)(```|~~~)/u;

function fenceMarker(line: string): string | undefined {
  const match = FENCE_PATTERN.exec(line);
  return match?.[2];
}

function isFenceClose(line: string, marker: string): boolean {
  return new RegExp(`^\\s*${marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*$`, "u").test(line);
}

function isSentenceBoundary(char: string): boolean {
  return char === "\n" || char === "." || "。！？!?；;…".includes(char);
}

/**
 * Strip Markdown decorations that read badly aloud. Applied to complete
 * sentences only, so streaming partials never see half-open syntax.
 */
export function cleanTtsText(text: string): string {
  const withoutBlocks = text
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/~~~[\s\S]*?~~~/gu, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/<[^>]+>/gu, " ")
    .replace(/`([^`]*)`/gu, "$1");

  const lines = withoutBlocks.split(/\r?\n/u).map((line) =>
    line
      .replace(/^#{1,6}\s+/u, "")
      .replace(/^>\s?/u, "")
      .replace(/^\s*[-*+]\s+/u, "")
      .replace(/^\s*\d+[.)、]\s*/u, "")
      .replace(/^[-=*_]{3,}$/u, ""),
  );

  return lines
    .join(" ")
    .replace(/[*_~`|]/gu, "")
    // Punctuation the melo lexicon has no entry for: the engine would skip
    // it with a console warning per character, so replace it with a pause.
    .replace(/[（）：“”‘’—…·]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Split cleaned text into sentence-sized speakable segments.
 */
export function splitTtsSentences(text: string, maxLength = MAX_SENTENCE_LENGTH): string[] {
  const cleaned = cleanTtsText(text);
  if (!cleaned) return [];

  const sentences: string[] = [];
  let cursor = 0;
  for (const match of cleaned.matchAll(SENTENCE_END)) {
    const end = (match.index ?? 0) + match[0].length;
    sentences.push(cleaned.slice(cursor, end).trim());
    cursor = end;
  }
  const tail = cleaned.slice(cursor).trim();
  if (tail) sentences.push(tail);

  const segments: string[] = [];
  for (const sentence of sentences) {
    if (sentence) splitLongSentence(sentence, maxLength, segments);
  }
  return segments;
}

function isComma(char: string): boolean {
  return char === "," || char === "，" || char === "、";
}

function splitLongSentence(sentence: string, maxLength: number, out: string[]): void {
  if (sentence.length <= maxLength) {
    out.push(sentence);
    return;
  }
  let rest = sentence;
  while (rest.length > maxLength) {
    const commas: number[] = [];
    for (let index = 0; index < maxLength && index < rest.length; index += 1) {
      if (isComma(rest[index] ?? "")) commas.push(index + 1);
    }
    const lower = Math.floor(maxLength * 0.6);
    const cut = commas.find((index) => index >= lower) ?? commas[commas.length - 1] ?? maxLength;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
}

interface Extraction {
  complete: string[];
  rest: string;
}

/** Sentence enders plus newlines: a finished line is a speakable boundary too. */
const ACCUMULATOR_END = /[。！？!?；;…]|\.{3,}|\n/gu;

function extractSentences(buffer: string, maxLength: number): Extraction {
  const raw: string[] = [];
  let cursor = 0;
  for (const match of buffer.matchAll(ACCUMULATOR_END)) {
    const end = (match.index ?? 0) + match[0].length;
    raw.push(buffer.slice(cursor, end));
    cursor = end;
  }
  const rest = buffer.slice(cursor);
  const complete = raw.flatMap((segment) => splitTtsSentences(segment, maxLength));
  return { complete, rest };
}

/**
 * A partial line that could still become a fenced code block opener
 * (```` ```python ```` or `~~~`). Its characters are held back from the
 * speakable buffer until the line stops looking like a fence.
 */
function couldBeFencePrefix(line: string): boolean {
  return (
    /^\s*`{0,2}$/u.test(line) ||
    /^\s*`{3,}/u.test(line) ||
    /^\s*~{0,2}$/u.test(line) ||
    /^\s*~{3,}/u.test(line)
  );
}

/**
 * Incrementally accumulates streaming chat deltas and yields complete
 * speakable sentences as soon as their ending punctuation or line break
 * arrives.
 *
 * Code fences are tracked across deltas: content inside an open fence is
 * dropped instead of being spoken.
 */
export class SentenceAccumulator {
  private pending = "";
  private line = "";
  private inFence = false;
  private fenceMarker = "";

  constructor(private readonly maxLength = MAX_SENTENCE_LENGTH) {}

  feed(text: string): string[] {
    const emitted: string[] = [];
    for (const char of text) {
      if (this.inFence) {
        if (char === "\n") {
          if (isFenceClose(this.line, this.fenceMarker)) {
            this.inFence = false;
            this.fenceMarker = "";
          }
          this.line = "";
        } else {
          this.line += char;
        }
        continue;
      }

      this.line += char;

      if (char === "\n") {
        const marker = fenceMarker(this.line);
        if (marker) {
          this.inFence = true;
          this.fenceMarker = marker;
          this.line = "";
          continue;
        }
        this.pending += this.line;
        this.line = "";
        emitted.push(...this.extract());
        continue;
      }

      if (!couldBeFencePrefix(this.line)) {
        this.pending += this.line;
        this.line = "";
        if (isSentenceBoundary(char)) emitted.push(...this.extract());
      }
    }
    return emitted;
  }

  private extract(): string[] {
    const { complete, rest } = extractSentences(this.pending, this.maxLength);
    this.pending = rest;
    return complete;
  }

  /** Flush whatever is left: the final trailing sentence, if any. */
  finish(): string[] {
    if (!this.inFence && this.line && !fenceMarker(this.line)) {
      this.pending += this.line;
    }
    const { complete, rest } = extractSentences(this.pending, this.maxLength);
    this.reset();
    const tail = splitTtsSentences(rest, this.maxLength);
    return [...complete, ...tail];
  }

  reset(): void {
    this.pending = "";
    this.line = "";
    this.inFence = false;
    this.fenceMarker = "";
  }
}
