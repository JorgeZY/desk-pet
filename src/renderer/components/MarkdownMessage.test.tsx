import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownMessage } from "./MarkdownMessage";

function renderMarkdown(content: string): string {
  return renderToStaticMarkup(<MarkdownMessage content={content} />);
}

describe("MarkdownMessage", () => {
  it("renders common Markdown and GFM structures", () => {
    const markup = renderMarkdown([
      "## 标题",
      "",
      "这是 **粗体**、*斜体* 和 ~~删除线~~。",
      "",
      "- 第一项",
      "- 第二项",
      "",
      "> 一段引用",
      "",
      "```ts",
      "const answer = 42;",
      "```",
      "",
      "| 名称 | 值 |",
      "| --- | --- |",
      "| answer | 42 |",
    ].join("\n"));

    expect(markup).toContain("<h2>标题</h2>");
    expect(markup).toContain("<strong>粗体</strong>");
    expect(markup).toContain("<em>斜体</em>");
    expect(markup).toContain("<del>删除线</del>");
    expect(markup).toContain("<ul>");
    expect(markup).toContain("<blockquote>");
    expect(markup).toContain('<code class="language-ts">');
    expect(markup).toContain("<table>");
  });

  it("renders GFM task lists with scoped checkbox hooks", () => {
    const markup = renderMarkdown("- [x] 已完成\n- [ ] 待处理");

    expect(markup).toContain('class="contains-task-list"');
    expect(markup.match(/class="task-list-item"/g)).toHaveLength(2);
    expect(markup.match(/type="checkbox"/g)).toHaveLength(2);
  });

  it("opens only absolute HTTPS links and degrades other protocols to text", () => {
    const markup = renderMarkdown([
      "[安全链接](https://example.com/docs)",
      "[脚本链接](javascript:alert(1))",
      "[邮件链接](mailto:test@example.com)",
      "[相对链接](/local/path)",
      "[带凭据链接](https://user:password@example.com/private)",
    ].join(" "));

    expect(markup.match(/<a /g)).toHaveLength(1);
    expect(markup).toContain('href="https://example.com/docs"');
    expect(markup).toContain('class="markdown-link--blocked">脚本链接</span>');
    expect(markup).toContain('class="markdown-link--blocked">邮件链接</span>');
    expect(markup).toContain('class="markdown-link--blocked">相对链接</span>');
    expect(markup).toContain('class="markdown-link--blocked">带凭据链接</span>');
    expect(markup).not.toContain("javascript:");
    expect(markup).not.toContain("mailto:");
    expect(markup).not.toContain("user:password");
  });

  it("skips raw HTML instead of placing it in the rendered tree", () => {
    const markup = renderMarkdown([
      '<script>alert("xss")</script>',
      '<img src="https://tracker.example/pixel" onerror="alert(1)">',
      "<b>原始 HTML</b>",
    ].join("\n"));

    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("onerror");
    expect(markup).not.toContain("tracker.example");
    expect(markup).not.toContain("<b>");
  });

  it("renders Markdown images as readable alt text without a network source", () => {
    const markup = renderMarkdown([
      "![架构图](https://tracker.example/architecture.png)",
      "![](https://tracker.example/unnamed.png)",
    ].join("\n\n"));

    expect(markup).toContain('<span class="markdown-image-alt">[图片：架构图]</span>');
    expect(markup).toContain('<span class="markdown-image-alt">[图片：未命名图片]</span>');
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("tracker.example");
  });

  it("handles incomplete streaming Markdown and reparses it after completion", () => {
    expect(() => renderMarkdown("**正在流式输出")).not.toThrow();
    expect(() => renderMarkdown("```ts\nconst partial = true;")).not.toThrow();

    const partial = renderMarkdown("**正在流式输出");
    const completed = renderMarkdown("**正在流式输出**");

    expect(partial).not.toContain("<strong>");
    expect(completed).toContain("<strong>正在流式输出</strong>");
  });

  it("accepts an additional class name without replacing its base class", () => {
    const markup = renderToStaticMarkup(
      <MarkdownMessage content="正文" className="reasoning-markdown" />,
    );

    expect(markup).toContain('class="markdown-message reasoning-markdown"');
  });
});
