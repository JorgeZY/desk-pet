import { describe, expect, it, vi } from "vitest";
import type { Data, NativeImage } from "electron";
import {
  pasteDictationText,
  resolveShortcutSpeechSource,
  type ClipboardLike,
} from "./global-dictation";

function clipboardMock(initial = "原剪贴板") {
  let text = initial;
  const write = vi.fn((data: Data) => { text = data.text ?? ""; });
  const target: ClipboardLike = {
    availableFormats: () => text ? ["text/plain"] : [],
    clear: () => { text = ""; },
    readBookmark: () => ({ title: "", url: "" }),
    readHTML: () => "",
    readImage: () => ({ isEmpty: () => true }) as NativeImage,
    readRTF: () => "",
    readText: () => text,
    write,
    writeText: (value) => { text = value; },
  };
  return { target, write, read: () => text, change: (value: string) => { text = value; } };
}

describe("global dictation paste", () => {
  it("routes F8 to the local draft only while a desk-pet composer owns focus", () => {
    expect(resolveShortcutSpeechSource(true, true)).toBe("button");
    expect(resolveShortcutSpeechSource(true, false)).toBe("shortcut");
    expect(resolveShortcutSpeechSource(false, true)).toBe("shortcut");
  });

  it("pastes recognized text and restores the previous clipboard", async () => {
    const clipboard = clipboardMock();
    const keyboard = { keyTap: vi.fn() };

    await pasteDictationText("  你好，世界  ", clipboard.target, keyboard, {
      paste: 47,
      control: 29,
    }, async () => undefined);

    expect(keyboard.keyTap).toHaveBeenCalledWith(47, [29]);
    expect(clipboard.read()).toBe("原剪贴板");
  });

  it("does not overwrite a clipboard changed while paste is pending", async () => {
    const clipboard = clipboardMock();
    const keyboard = { keyTap: vi.fn() };
    let waits = 0;

    await pasteDictationText("语音结果", clipboard.target, keyboard, {
      paste: 47,
      control: 29,
    }, async () => {
      waits += 1;
      if (waits === 2) clipboard.change("用户的新剪贴板");
    });

    expect(clipboard.read()).toBe("用户的新剪贴板");
    expect(clipboard.write).not.toHaveBeenCalled();
  });
});
