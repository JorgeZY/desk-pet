// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeState, TtsState } from "../../shared/types";
import {
  createDesktopToolMetadata,
  type DesktopUIMessage,
} from "../chat/desktop-ui-message";
import { ChatMessageView } from "./ChatMessageView";

const runtime: RuntimeState = {
  phase: "ready",
  visionEnabled: true,
  endpoint: "http://127.0.0.1:18766",
  message: "模型已就绪。",
  updatedAt: 1,
};

const tts: TtsState = {
  enabled: true,
  phase: "ready",
  message: "语音朗读模型已就绪。",
  modelDirectory: "D:\\models\\tts",
  updatedAt: 1,
};

afterEach(cleanup);

describe("ChatMessageView", () => {
  it("renders assistant output in a distinct contained message surface", () => {
    const { container } = renderMessage({
      id: "assistant-contained",
      role: "assistant",
      parts: [{ type: "text", text: "已经完成检查。", state: "done" }],
    });

    const content = container.querySelector('[data-slot="message-content"]');
    expect(content?.className).toContain("group-[.is-assistant]:bg-card/90");
    expect(content?.className).toContain("group-[.is-assistant]:border-border/80");
    expect(content?.className).not.toContain("border-l-primary");
    expect(screen.getByText("已经完成检查。")).toBeTruthy();
  });

  it("shows a contained loading state while the assistant is waiting to generate", () => {
    const { container } = renderMessage({
      id: "assistant-waiting",
      role: "assistant",
      parts: [],
    }, { activeRequestId: "active-request" });

    const content = container.querySelector('[data-slot="message-content"]');
    expect(content?.getAttribute("data-loading")).toBe("true");
    expect(content?.className).not.toContain("before:animate-pulse");
    expect(content?.className).toContain("min-w-36");
    expect(container.querySelector('[data-slot="assistant-loading-dots"]')).toBeNull();
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("回答生成中");
    expect(status.className).toContain("justify-center");
    expect(status.className).toContain("text-center");
    const loadingIcon = container.querySelector('[data-slot="assistant-loading-icon"]');
    expect(loadingIcon?.className).toContain("motion-safe:animate-spin");
    expect(loadingIcon?.className).toContain("[animation-duration:1.25s]");
    const loadingText = container.querySelector('[data-slot="shimmer"]');
    expect(loadingText?.getAttribute("data-slot")).toBe("shimmer");
    expect(loadingText?.className).toContain("shimmer");
    expect((loadingText as HTMLElement | null)?.style.color).toBe(
      "var(--ui-foreground)",
    );
    expect((loadingText as HTMLElement | null)?.style.getPropertyValue(
      "--shimmer-color",
    )).toBe("var(--ui-primary)");
    expect((loadingText as HTMLElement | null)?.style.getPropertyValue(
      "--shimmer-duration",
    )).toBe("1.8s");
  });

  it("uses an accessible image placeholder when history has no preview URL", () => {
    renderMessage({
      id: "historical-images",
      role: "user",
      parts: [
        {
          type: "data-image-attachment",
          id: "image-historical",
          data: {
            path: "D:\\archived-cat.png",
            name: "archived-cat.png",
            mimeType: "image/png",
          },
        },
        {
          type: "data-image-attachment",
          id: "image-current",
          data: {
            path: "D:\\current-cat.png",
            name: "current-cat.png",
            mimeType: "image/png",
            previewUrl: "data:image/png;base64,cHJldmlldw==",
          },
        },
      ],
    });

    const historical = screen.getByRole("group", {
      name: "附件：archived-cat.png",
    });
    expect(within(historical).queryByRole("img")).toBeNull();
    expect(historical.querySelector("svg")).toBeTruthy();
    expect(within(historical).getByText("archived-cat.png")).toBeTruthy();

    const current = screen.getByRole("group", {
      name: "附件：current-cat.png",
    });
    const preview = within(current).getByRole("img", { name: "current-cat.png" });
    expect(preview.getAttribute("src")).toBe("data:image/png;base64,cHJldmlldw==");
  });

  it("renders supported UI message parts in their array order without duplicating tool results", () => {
    const message: DesktopUIMessage = {
      id: "assistant-order",
      role: "assistant",
      metadata: { createdAt: 10 },
      parts: [
        { type: "text", text: "第一段", state: "done" },
        {
          type: "data-image-attachment",
          id: "image-1",
          data: {
            path: "D:\\cat.png",
            name: "cat.png",
            mimeType: "image/png",
            previewUrl: "data:image/png;base64,",
          },
        },
        { type: "reasoning", id: "reasoning-1", text: "分析过程", state: "done" },
        {
          type: "dynamic-tool",
          toolName: "read_file",
          toolCallId: "tool-1",
          title: "读取文件",
          state: "output-available",
          input: { path: "notes.txt" },
          output: "主要结果",
          toolMetadata: createDesktopToolMetadata({
            displayName: "读取文件",
            requiresApproval: false,
            arguments: "{\"path\":\"notes.txt\"}",
          }),
        },
        {
          type: "data-tool-result",
          id: "tool-1",
          data: {
            toolCallId: "tool-1",
            status: "completed",
            resultPresent: true,
            errorPresent: false,
            result: "不应重复显示",
          },
        },
        {
          type: "data-document-attachment",
          id: "document-1",
          data: {
            path: "D:\\notes.pdf",
            name: "notes.pdf",
            mimeType: "application/pdf",
            text: "body",
            characterCount: 4,
            truncated: false,
          },
        },
        { type: "text", text: "第二段", state: "done" },
      ],
    };

    renderMessage(message);

    const orderedNodes = [
      screen.getByText("第一段"),
      screen.getByText("cat.png"),
      screen.getByText("查看思考过程"),
      screen.getByText("读取文件"),
      screen.getByText("notes.pdf"),
      screen.getByText("第二段"),
    ];
    for (let index = 0; index < orderedNodes.length - 1; index += 1) {
      expect(
        orderedNodes[index].compareDocumentPosition(orderedNodes[index + 1])
        & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }

    fireEvent.click(screen.getByRole("button", { name: /读取文件/ }));
    expect(screen.getByText("主要结果")).toBeTruthy();
    expect(screen.queryByText("不应重复显示")).toBeNull();
  });

  it("routes dynamic tool approval through the active request", () => {
    const onApproval = vi.fn();
    renderMessage({
      id: "assistant-approval",
      role: "assistant",
      parts: [{
        type: "dynamic-tool",
        toolName: "write_file",
        toolCallId: "tool-approval",
        title: "写入文件",
        state: "approval-requested",
        input: { path: "a.txt" },
        approval: { id: "approval-1" },
        toolMetadata: createDesktopToolMetadata({
          displayName: "写入文件",
          requiresApproval: true,
          arguments: "{\"path\":\"a.txt\"}",
          requestId: "metadata-request",
        }),
      }],
    }, { activeRequestId: "active-request", onApproval });

    fireEvent.click(screen.getByRole("button", { name: "允许本次调用" }));
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));

    expect(onApproval).toHaveBeenNthCalledWith(
      1,
      "active-request",
      "tool-approval",
      true,
    );
    expect(onApproval).toHaveBeenNthCalledWith(
      2,
      "active-request",
      "tool-approval",
      false,
    );
  });

  it("marks only a final active assistant reasoning part as streaming", () => {
    const reasoningPart = {
      type: "reasoning" as const,
      id: "reasoning-active",
      text: "还在分析",
      state: "streaming" as const,
    };
    const { rerender } = renderMessage({
      id: "assistant-reasoning",
      role: "assistant",
      parts: [
        reasoningPart,
        {
          type: "data-tool-result",
          id: "supplemental",
          data: {
            toolCallId: "missing-tool",
            status: "completed",
            resultPresent: false,
            errorPresent: false,
          },
        },
      ],
    }, { activeRequestId: "active-request" });

    expect(screen.getByText("正在思考…")).toBeTruthy();

    rerender(view({
      id: "assistant-reasoning",
      role: "assistant",
      parts: [
        reasoningPart,
        { type: "text", text: "开始回答", state: "streaming" },
      ],
    }, { activeRequestId: "active-request" }));

    expect(screen.getByText("查看思考过程")).toBeTruthy();
    expect(screen.queryByText("正在思考…")).toBeNull();
  });

  it("derives the persisted ChatMessage snapshot for message actions", () => {
    const onCopy = vi.fn().mockResolvedValue(undefined);
    const onContinue = vi.fn();
    renderMessage({
      id: "assistant-actions",
      role: "assistant",
      metadata: { createdAt: 42 },
      parts: [
        { type: "text", text: "前半", state: "done" },
        { type: "reasoning", id: "reasoning-actions", text: "推理", state: "done" },
        { type: "text", text: "后半", state: "done" },
      ],
    }, { onContinue, onCopy });

    fireEvent.click(screen.getByRole("button", { name: "复制这段回答" }));
    fireEvent.click(screen.getByRole("button", { name: "继续生成这段回答" }));

    const expectedSnapshot = {
      id: "assistant-actions",
      role: "assistant",
      content: "前半后半",
      parts: [
        { type: "text", text: "前半" },
        { type: "reasoning", text: "推理" },
        { type: "text", text: "后半" },
      ],
      reasoning: "推理",
      createdAt: 42,
    };
    expect(onCopy).toHaveBeenCalledWith(expectedSnapshot);
    expect(onContinue).toHaveBeenCalledWith(expectedSnapshot);
  });
});

interface ViewOverrides {
  activeRequestId?: string;
  onApproval?: ReturnType<typeof vi.fn>;
  onContinue?: ReturnType<typeof vi.fn>;
  onCopy?: ReturnType<typeof vi.fn>;
}

function view(message: DesktopUIMessage, overrides: ViewOverrides = {}) {
  return (
    <ChatMessageView
      activeRequestId={overrides.activeRequestId}
      conversationOperationPending={false}
      isLast
      message={message}
      onApproval={overrides.onApproval ?? vi.fn()}
      onContinue={overrides.onContinue ?? vi.fn()}
      onCopy={overrides.onCopy ?? vi.fn().mockResolvedValue(undefined)}
      onRegenerate={vi.fn()}
      onSpeakText={vi.fn().mockResolvedValue(undefined)}
      onStopSpeaking={vi.fn().mockResolvedValue(undefined)}
      runtime={runtime}
      tts={tts}
    />
  );
}

function renderMessage(
  message: DesktopUIMessage,
  overrides: ViewOverrides = {},
) {
  return render(view(message, overrides));
}
