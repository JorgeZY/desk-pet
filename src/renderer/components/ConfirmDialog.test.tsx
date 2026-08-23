import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";

describe("ConfirmDialog", () => {
  it("renders an accessible pixel-style destructive confirmation", () => {
    const markup = renderToStaticMarkup(
      <ConfirmDialog
        title="删除这个对话？"
        description="测试对话及其中 3 条消息将被永久删除。"
        confirmLabel="删除对话"
        pendingLabel="删除中…"
        pending={false}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    );

    expect(markup).toContain('role="alertdialog"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-busy="false"');
    expect(markup).toContain("confirm-dialog--danger");
    expect(markup).toContain("删除这个对话？");
    expect(markup).toContain("测试对话及其中 3 条消息将被永久删除。");
    expect(markup).toContain("取消");
    expect(markup).toContain("删除对话");
    expect(markup).toContain('data-lucide-icon="trash"');
  });

  it("keeps the dialog mounted and exposes pending state during deletion", () => {
    const markup = renderToStaticMarkup(
      <ConfirmDialog
        title="删除这个对话？"
        description="此操作无法恢复。"
        confirmLabel="删除对话"
        pendingLabel="删除中…"
        pending
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("删除中…");
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
  });
});
