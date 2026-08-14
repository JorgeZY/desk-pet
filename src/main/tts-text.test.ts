import { describe, expect, it } from "vitest";
import { cleanTtsText, SentenceAccumulator, splitTtsSentences } from "./tts-text";

describe("cleanTtsText", () => {
  it("keeps plain speech untouched", () => {
    expect(cleanTtsText("你好，我是团子。")).toBe("你好，我是团子。");
  });

  it("strips markdown decorations and keeps link text", () => {
    expect(
      cleanTtsText("**重要**：请访问 [官网](https://example.com) 查看 `config.json`。"),
    ).toBe("重要：请访问 官网 查看 config.json。");
  });

  it("drops fenced code blocks entirely", () => {
    expect(
      cleanTtsText("先看代码：\n```js\nconst a = 1;\n```\n然后继续。"),
    ).toBe("先看代码： 然后继续。");
  });

  it("removes headings, lists, blockquotes, and horizontal rules", () => {
    expect(
      cleanTtsText("## 标题\n- 第一点\n1. 第二点\n> 引用\n---\n正文"),
    ).toBe("标题 第一点 第二点 引用 正文");
  });

  it("collapses whitespace across lines", () => {
    expect(cleanTtsText("第一行\n\n第二行")).toBe("第一行 第二行");
  });
});

describe("splitTtsSentences", () => {
  it("splits on Chinese and ASCII sentence enders and keeps punctuation", () => {
    expect(splitTtsSentences("你好！今天怎么样？我很好。Bye! See you.")).toEqual([
      "你好！",
      "今天怎么样？",
      "我很好。",
      "Bye!",
      "See you.",
    ]);
  });

  it("splits over-long sentences at comma boundaries", () => {
    const long = `${"很长的内容，".repeat(60)}结束。`;
    const segments = splitTtsSentences(long);
    expect(segments.length).toBeGreaterThan(2);
    expect(segments.every((segment) => segment.length <= 120)).toBe(true);
    expect(segments.join("")).toBe(long);
  });

  it("hard-cuts sentences without any commas", () => {
    const long = "字".repeat(300);
    const segments = splitTtsSentences(long);
    expect(segments.every((segment) => segment.length <= 120)).toBe(true);
    expect(segments.join("")).toBe(long);
  });

  it("returns nothing for empty or markdown-only text", () => {
    expect(splitTtsSentences("")).toEqual([]);
    expect(splitTtsSentences("```\ncode only\n```")).toEqual([]);
    expect(splitTtsSentences("** **")).toEqual([]);
  });
});

describe("SentenceAccumulator", () => {
  it("emits sentences as soon as their ending punctuation arrives", () => {
    const accumulator = new SentenceAccumulator();

    expect(accumulator.feed("你好")).toEqual([]);
    expect(accumulator.feed("！")).toEqual(["你好！"]);
    expect(accumulator.feed("今天")).toEqual([]);
    expect(accumulator.feed("天气不错。")).toEqual(["今天天气不错。"]);
    expect(accumulator.finish()).toEqual([]);
  });

  it("emits several sentences from a single delta", () => {
    const accumulator = new SentenceAccumulator();
    expect(accumulator.feed("第一句。第二句！第三句？")).toEqual([
      "第一句。",
      "第二句！",
      "第三句？",
    ]);
    expect(accumulator.finish()).toEqual([]);
  });

  it("flushes the trailing partial sentence on finish", () => {
    const accumulator = new SentenceAccumulator();
    accumulator.feed("第一句。");
    expect(accumulator.finish()).toEqual([]);
    accumulator.feed("没有标点的结尾");
    expect(accumulator.finish()).toEqual(["没有标点的结尾"]);
  });

  it("drops fenced code even when the fence spans deltas", () => {
    const accumulator = new SentenceAccumulator();
    expect(accumulator.feed("先看例子：\n```py\nprint(1)\n")).toEqual(["先看例子："]);
    expect(accumulator.feed("print(2)\n")).toEqual([]);
    expect(accumulator.feed("```\n")).toEqual([]);
    expect(accumulator.feed("现在继续。")).toEqual(["现在继续。"]);
    expect(accumulator.finish()).toEqual([]);
  });

  it("drops unclosed fence content on finish", () => {
    const accumulator = new SentenceAccumulator();
    accumulator.feed("开头。\n```js\n永远不结束");
    expect(accumulator.finish()).toEqual([]);
  });

  it("cleans markdown from emitted sentences", () => {
    const accumulator = new SentenceAccumulator();
    expect(accumulator.feed("**加粗**的内容。")).toEqual(["加粗的内容。"]);
  });

  it("reset clears buffered text", () => {
    const accumulator = new SentenceAccumulator();
    accumulator.feed("半句话");
    accumulator.reset();
    expect(accumulator.finish()).toEqual([]);
  });

  it("handles newline-separated lines as sentence boundaries", () => {
    const accumulator = new SentenceAccumulator();
    expect(accumulator.feed("第一行\n")).toEqual(["第一行"]);
    expect(accumulator.finish()).toEqual([]);
  });
});
