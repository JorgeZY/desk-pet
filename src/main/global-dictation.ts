import type { Data, NativeImage } from "electron";
import type { SpeechSessionSource } from "../shared/types";

export interface ClipboardLike {
  availableFormats(): string[];
  clear(): void;
  readBookmark(): { title: string; url: string };
  readHTML(): string;
  readImage(): NativeImage;
  readRTF(): string;
  readText(): string;
  write(data: Data): void;
  writeText(text: string): void;
}

export interface KeyboardLike {
  keyTap(key: number, modifiers?: number[]): void;
}

interface ClipboardSnapshot {
  data: Data;
  hadContents: boolean;
}

export function resolveShortcutSpeechSource(
  composerFocused: boolean,
  appWindowFocused: boolean,
): SpeechSessionSource {
  return composerFocused && appWindowFocused ? "button" : "shortcut";
}

function captureClipboard(target: ClipboardLike): ClipboardSnapshot {
  const formats = target.availableFormats();
  const data: Data = {};
  const text = target.readText();
  const html = target.readHTML();
  const rtf = target.readRTF();
  const image = target.readImage();
  const bookmark = target.readBookmark();

  if (text) data.text = text;
  if (html) data.html = html;
  if (rtf) data.rtf = rtf;
  if (!image.isEmpty()) data.image = image;
  if (bookmark.url) {
    data.text ??= bookmark.url;
    data.bookmark = bookmark.title;
  }

  return { data, hadContents: formats.length > 0 };
}

function restoreClipboard(target: ClipboardLike, snapshot: ClipboardSnapshot): void {
  target.clear();
  if (snapshot.hadContents && Object.keys(snapshot.data).length > 0) {
    target.write(snapshot.data);
  }
}

export async function pasteDictationText(
  text: string,
  target: ClipboardLike,
  keyboard: KeyboardLike,
  keys: { paste: number; control: number },
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<void> {
  const value = text.trim();
  if (!value) return;

  const snapshot = captureClipboard(target);
  target.writeText(value);
  await wait(30);
  keyboard.keyTap(keys.paste, [keys.control]);
  await wait(180);

  // Do not overwrite clipboard content that the user changed while paste was pending.
  if (target.readText() === value) restoreClipboard(target, snapshot);
}
