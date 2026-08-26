// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatConversation } from "../../shared/types";
import { ChatHistoryList, type ChatHistoryListProps } from "./ChatHistoryList";

const conversations: ChatConversation[] = [
  {
    id: "conversation-1",
    title: "整理发布说明",
    createdAt: 1,
    updatedAt: 1_700_000_000_000,
    messageCount: 4,
  },
  {
    id: "conversation-2",
    title: "检查本地模型",
    createdAt: 2,
    updatedAt: 1_700_000_100_000,
    messageCount: 2,
  },
];

function renderHistory(overrides: Partial<ChatHistoryListProps> = {}) {
  const props: ChatHistoryListProps = {
    conversations,
    conversationId: "conversation-1",
    batchMode: false,
    selectedIds: new Set(),
    busy: false,
    generationActive: false,
    onToggleBatch: vi.fn(),
    onToggleSelection: vi.fn(),
    onToggleSelectAll: vi.fn(),
    onDeleteSelected: vi.fn(),
    onSwitch: vi.fn(),
    onRequestDelete: vi.fn(),
    ...overrides,
  };
  return { ...render(<ChatHistoryList {...props} />), props };
}

afterEach(cleanup);

describe("ChatHistoryList", () => {
  it("loads a conversation directly from its topic button", async () => {
    const user = userEvent.setup();
    const { props } = renderHistory();

    await user.click(screen.getByRole("button", { name: /^检查本地模型/ }));

    expect(props.onSwitch).toHaveBeenCalledWith("conversation-2");
    expect(screen.queryByRole("button", { name: "聊天" })).toBeNull();
  });

  it("opens the Radix action menu and forwards the focused delete trigger", async () => {
    const user = userEvent.setup();
    const { props } = renderHistory();

    const trigger = screen.getByRole("button", { name: "管理 整理发布说明" });
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: "删除对话" }));

    expect(props.onRequestDelete).toHaveBeenCalledWith(
      conversations[0],
      trigger,
    );
  });

  it("keeps only the requested three-dot action highlighted for delete confirmation", () => {
    renderHistory({ pendingDeleteId: "conversation-1" });

    const trigger = screen.getByRole("button", { name: "管理 整理发布说明" });
    const conversationRow = trigger.closest(".group");
    expect(trigger.getAttribute("data-active")).toBe("true");
    expect(trigger.className).toContain("data-[active=true]:opacity-100");
    expect(trigger.className).toContain("opacity-0");
    expect(conversationRow?.className).not.toContain("focus-within:bg-sidebar-accent");
  });

  it("contains and truncates long topic titles inside the sidebar", () => {
    const longTitle = "帮我翻译下面这句话 > desk-pet@0.2.1 dev 并继续补充一段很长的说明";
    const longConversation: ChatConversation = {
      ...conversations[0],
      title: longTitle,
    };
    const { container } = renderHistory({
      conversations: [longConversation],
      conversationId: longConversation.id,
    });

    const topicButton = screen.getByTitle(longTitle);
    const row = topicButton.closest('[data-slot="conversation-history-item"]');
    const title = within(topicButton).getByText(longTitle);
    const menuTrigger = screen.getByRole("button", { name: `管理 ${longTitle}` });

    expect(container.firstElementChild?.className).toContain("overflow-hidden");
    expect(row?.className).toContain("max-w-full");
    expect(row?.className).toContain("overflow-x-hidden");
    expect(topicButton.className).toContain("overflow-hidden");
    expect(title.className).toContain("truncate");
    expect(title.parentElement?.className).toContain("flex-1");
    expect(menuTrigger.className).toContain("shrink-0");
  });

  it("locks switching and destructive actions while generation is active", () => {
    renderHistory({ generationActive: true });

    expect((screen.getByRole("button", { name: /^整理发布说明/ }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByRole("button", { name: "管理 整理发布说明" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByRole("button", { name: "管理对话" }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it("keeps batch actions compact and gives selection controls clear states", async () => {
    const user = userEvent.setup();
    const selectedIds = new Set(conversations.map((item) => item.id));
    const { props } = renderHistory({ batchMode: true, selectedIds });

    const cancelAll = screen.getByRole("button", { name: "取消全选" });
    expect(cancelAll.getAttribute("data-variant")).toBe("secondary");
    expect(cancelAll.className).toContain("hover:border-primary/60");
    expect(screen.getByText("已选中 2 个").className).toContain("whitespace-nowrap");

    const deleteSelected = screen.getByRole("button", { name: "删除已选中的 2 个对话" });
    expect(deleteSelected.getAttribute("data-size")).toBe("icon-sm");
    expect(deleteSelected.textContent).toBe("");
    expect(screen.getByRole("checkbox", { name: "选择 整理发布说明" }).className).toContain("ml-2");
    expect(screen.getByRole("checkbox", { name: "选择 整理发布说明" }).className)
      .toContain("hover:-translate-y-px");

    await user.click(cancelAll);
    expect(props.onToggleSelectAll).toHaveBeenCalledOnce();
  });
});
