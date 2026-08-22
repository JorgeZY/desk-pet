import type { CaptionState } from "../shared/types";

export interface CaptionDisplayText {
  text: string;
  live: boolean;
}

export interface CaptionPresentation {
  lines: string[];
  live: boolean;
}

const MIN_CHARACTERS_PER_LINE = 26;
const MAX_CHARACTERS_PER_LINE = 56;

export function captionCharactersPerLine(fontSize: number): number {
  const safeFontSize = Number.isFinite(fontSize) ? fontSize : 22;
  return Math.min(
    MAX_CHARACTERS_PER_LINE,
    Math.max(MIN_CHARACTERS_PER_LINE, Math.floor(960 / safeFontSize)),
  );
}

export function captionMaximumLines(fontSize: number): 1 | 2 {
  return Number.isFinite(fontSize) && fontSize >= 26 ? 1 : 2;
}

export function wrapCaptionLines(text: string, fontSize: number): string[] {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) return [];

  const limit = captionCharactersPerLine(fontSize);
  const lines: string[] = [];
  let current = "";
  const pushCurrent = (): void => {
    if (current) lines.push(current);
    current = "";
  };

  for (const word of normalized.split(" ")) {
    const characters = Array.from(word);
    if (characters.length > limit) {
      pushCurrent();
      for (let index = 0; index < characters.length; index += limit) {
        const chunk = characters.slice(index, index + limit).join("");
        if (Array.from(chunk).length === limit) lines.push(chunk);
        else current = chunk;
      }
      continue;
    }

    const next = current ? `${current} ${word}` : word;
    if (Array.from(next).length <= limit) current = next;
    else {
      pushCurrent();
      current = word;
    }
  }

  pushCurrent();
  return lines;
}

export function formatCaptionLines(text: string, fontSize: number): string[] {
  return wrapCaptionLines(text, fontSize).slice(-captionMaximumLines(fontSize));
}

export function selectCaptionDisplayText(
  state: Pick<CaptionState, "partial" | "segments"> | null,
): CaptionDisplayText {
  const partial = state?.partial.trim() ?? "";
  if (partial) return { text: partial, live: true };
  const latest = state?.segments.at(-1)?.text.trim() ?? "";
  return { text: latest, live: false };
}

export class StableCaptionPresenter {
  private sessionId?: string;
  private fontSize?: number;
  private wasLive = false;
  private stableLine = "";
  private candidateLine = "";
  private candidateCount = 0;

  update(state: CaptionState | null, fontSize: number): CaptionPresentation {
    if (this.sessionId !== state?.sessionId || this.fontSize !== fontSize) {
      this.sessionId = state?.sessionId;
      this.fontSize = fontSize;
      this.resetLiveState();
    }

    const display = selectCaptionDisplayText(state);
    if (!display.live) {
      this.resetLiveState();
      return { lines: formatCaptionLines(display.text, fontSize), live: false };
    }
    if (!this.wasLive) this.resetLiveState();
    this.wasLive = true;

    const wrapped = wrapCaptionLines(display.text, fontSize);
    if (captionMaximumLines(fontSize) === 1 || wrapped.length <= 1) {
      return { lines: wrapped.slice(-1), live: true };
    }

    const completedLine = wrapped.at(-2) ?? "";
    if (completedLine === this.candidateLine) this.candidateCount += 1;
    else {
      this.candidateLine = completedLine;
      this.candidateCount = 1;
    }
    if (this.candidateCount >= 2) this.stableLine = completedLine;

    const liveLine = wrapped.at(-1) ?? "";
    const lines = this.stableLine && this.stableLine !== liveLine
      ? [this.stableLine, liveLine]
      : wrapped.slice(-2);
    return { lines, live: true };
  }

  private resetLiveState(): void {
    this.wasLive = false;
    this.stableLine = "";
    this.candidateLine = "";
    this.candidateCount = 0;
  }
}
