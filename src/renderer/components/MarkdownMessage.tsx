import { memo, type ComponentPropsWithoutRef, type MouseEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export interface MarkdownMessageProps {
  content: string;
  className?: string;
}

function safeHttpsUrl(value: string | undefined): string | null {
  if (!value) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function markdownUrlTransform(value: string, key: string): string {
  // Links are opened by the restricted preload API below. Images and every
  // other URL-bearing Markdown node deliberately receive no loadable URL.
  return key === "href" ? safeHttpsUrl(value) ?? "" : "";
}

function SafeMarkdownLink({
  href,
  children,
  title,
}: ComponentPropsWithoutRef<"a">) {
  const safeHref = safeHttpsUrl(href);
  if (!safeHref) {
    return (
      <span className="markdown-link--blocked" title={title}>
        {children}
      </span>
    );
  }

  const openExternal = (event: MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    void window.desktopPet.openExternal(safeHref).catch(() => undefined);
  };

  return (
    <a href={safeHref} title={title} rel="noreferrer noopener" onClick={openExternal}>
      {children}
    </a>
  );
}

function MarkdownImageAlt({ alt }: ComponentPropsWithoutRef<"img">) {
  const label = alt?.trim() || "未命名图片";
  return <span className="markdown-image-alt">[图片：{label}]</span>;
}

const MARKDOWN_COMPONENTS = {
  a: SafeMarkdownLink,
  img: MarkdownImageAlt,
};

const MARKDOWN_PLUGINS = [remarkGfm];

export const MarkdownMessage = memo(function MarkdownMessage({
  content,
  className,
}: MarkdownMessageProps) {
  const classes = className ? `markdown-message ${className}` : "markdown-message";

  return (
    <div className={classes}>
      <ReactMarkdown
        remarkPlugins={MARKDOWN_PLUGINS}
        components={MARKDOWN_COMPONENTS}
        skipHtml
        urlTransform={markdownUrlTransform}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
