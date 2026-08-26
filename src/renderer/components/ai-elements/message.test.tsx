import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageResponse } from "./message";

function renderMessage(content: string): string {
  return renderToStaticMarkup(<MessageResponse mode="static">{content}</MessageResponse>);
}

describe("MessageResponse", () => {
  it("renders Markdown while preserving the Electron link boundary", () => {
    const markup = renderMessage([
      "## 标题",
      "",
      "这是 **粗体** 和 ~~删除线~~。",
      "",
      "[安全链接](https://example.com/docs)",
      "[脚本链接](javascript:alert(1))",
      "[相对链接](/local/path)",
      "[带凭据链接](https://user:password@example.com/private)",
    ].join("\n"));

    expect(markup).toContain("<h2");
    expect(markup).toContain('data-streamdown="strong">粗体</span>');
    expect(markup).toContain("<del>删除线</del>");
    expect(markup.match(/<a /g)).toHaveLength(1);
    expect(markup).toContain('href="https://example.com/docs"');
    expect(markup).toContain('class="markdown-link--blocked"');
    expect(markup).not.toContain("javascript:");
    expect(markup).not.toContain("user:password");
  });

  it("blocks raw HTML and remote image loads", () => {
    const markup = renderMessage([
      '<script>alert("xss")</script>',
      '<img src="https://tracker.example/pixel" onerror="alert(1)">',
      "![架构图](https://tracker.example/architecture.png)",
    ].join("\n\n"));

    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("onerror");
    expect(markup).not.toContain("tracker.example");
    expect(markup).toContain("[图片：架构图]");
  });
});
