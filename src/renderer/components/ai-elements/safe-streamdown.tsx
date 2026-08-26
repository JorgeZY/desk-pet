import type { ComponentPropsWithoutRef, MouseEvent } from "react";
import type { Components, UrlTransform } from "streamdown";

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
    <a href={safeHref} onClick={openExternal} rel="noreferrer noopener" title={title}>
      {children}
    </a>
  );
}

function MarkdownImageAlt({ alt }: ComponentPropsWithoutRef<"img">) {
  const label = alt?.trim() || "未命名图片";
  return <span className="markdown-image-alt">[图片：{label}]</span>;
}

export const safeStreamdownComponents = {
  a: SafeMarkdownLink,
  img: MarkdownImageAlt,
} as Components;

export const safeStreamdownUrlTransform: UrlTransform = (value, key) => (
  key === "href" ? safeHttpsUrl(value) ?? "" : ""
);
