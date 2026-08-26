// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatDocument,
  ChatEvent,
  ChatImage,
  ChatRequest,
  DesktopPetApi,
  RuntimeState,
  SpeechState,
  TtsState,
} from "../../shared/types";
import { TooltipProvider } from "./ui/tooltip";
import { ChatPanel } from "./ChatPanel";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

const runtime: RuntimeState = {
  phase: "ready",
  visionEnabled: true,
  endpoint: "http://127.0.0.1:18766",
  message: "模型已就绪。",
  updatedAt: 1,
};

const speech: SpeechState = {
  enabled: true,
  phase: "ready",
  message: "语音模型已就绪。",
  modelDirectory: "D:\\models\\speech",
  updatedAt: 1,
};

const tts: TtsState = {
  enabled: true,
  phase: "ready",
  message: "语音朗读模型已就绪。",
  modelDirectory: "D:\\models\\tts",
  updatedAt: 1,
};

const conversation = {
  id: "conversation-1",
  title: "发布前检查",
  createdAt: 1,
  updatedAt: 2,
  messageCount: 0,
};

interface DesktopPetMock {
  api: Record<string, ReturnType<typeof vi.fn>>;
  emit: (event: ChatEvent) => void;
}

function installDesktopPetMock(): DesktopPetMock {
  let listener: ((event: ChatEvent) => void) | undefined;
  const api = {
    listChatConversations: vi.fn().mockResolvedValue([conversation]),
    createChatConversation: vi.fn().mockResolvedValue(conversation),
    loadChatConversation: vi.fn().mockResolvedValue([]),
    saveChatMessages: vi.fn().mockResolvedValue(undefined),
    deleteChatConversations: vi.fn().mockResolvedValue(undefined),
    getWorkbenchWindowState: vi.fn().mockResolvedValue({
      maximized: false,
      sidebarCollapsed: false,
    }),
    onWorkbenchWindowState: vi.fn().mockReturnValue(() => undefined),
    setSidebarCollapsed: vi.fn().mockResolvedValue({
      maximized: false,
      sidebarCollapsed: true,
    }),
    startChat: vi.fn(),
    abortChat: vi.fn(),
    onChatEvent: vi.fn((nextListener: (event: ChatEvent) => void) => {
      listener = nextListener;
      return () => {
        if (listener === nextListener) listener = undefined;
      };
    }),
    resolveToolApproval: vi.fn(),
    setSpeechComposerFocused: vi.fn(),
    pickChatImages: vi.fn().mockResolvedValue([]),
    pickChatDocuments: vi.fn().mockResolvedValue([]),
  };
  Object.defineProperty(window, "desktopPet", {
    configurable: true,
    value: api as unknown as DesktopPetApi,
  });
  return {
    api,
    emit: (event) => {
      if (!listener) throw new Error("Chat listener is not attached.");
      listener(event);
    },
  };
}

function ChatPanelHarness(
  overrides: Partial<ComponentProps<typeof ChatPanel>> = {},
) {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<ChatImage[]>([]);
  const [documents, setDocuments] = useState<ChatDocument[]>([]);
  return (
    <TooltipProvider>
      <ChatPanel
        runtime={runtime}
        speech={speech}
        tts={tts}
        chatTemplates={["总结这份资料", "规划下一步"]}
        maxTokens={2048}
        contextSize={8192}
        modelLabel="MiniCPM5-1B-Q4_K_M"
        draft={draft}
        images={images}
        documents={documents}
        onDraftChange={setDraft}
        onImagesChange={setImages}
        onDocumentsChange={setDocuments}
        visionEnabled
        onPrepareSpeech={vi.fn().mockResolvedValue(undefined)}
        onStartSpeech={vi.fn().mockResolvedValue(undefined)}
        onStopSpeech={vi.fn().mockResolvedValue(undefined)}
        onSpeakText={vi.fn().mockResolvedValue(undefined)}
        onStopSpeaking={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
        onStartRuntime={vi.fn().mockResolvedValue(undefined)}
        {...overrides}
      />
    </TooltipProvider>
  );
}

beforeEach(() => {
  const ids: Array<ReturnType<typeof crypto.randomUUID>> = [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000003",
    "00000000-0000-4000-8000-000000000004",
    "00000000-0000-4000-8000-000000000005",
    "00000000-0000-4000-8000-000000000006",
  ];
  vi.spyOn(crypto, "randomUUID").mockImplementation(() => (
    ids.shift() ?? "00000000-0000-4000-8000-999999999999"
  ));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ChatPanel workbench", () => {
  it("keeps the sidebar toggle actionable in compact mode", async () => {
    const { api } = installDesktopPetMock();
    api.getWorkbenchWindowState.mockResolvedValue({
      maximized: false,
      sidebarCollapsed: true,
    });
    api.setSidebarCollapsed.mockResolvedValue({
      maximized: false,
      sidebarCollapsed: false,
    });
    const user = userEvent.setup();
    render(<ChatPanelHarness />);

    const expand = await screen.findByRole("button", { name: "展开侧栏" });
    expect(expand.closest("aside")?.className).toContain("w-[72px]");
    expect(expand.closest("aside")?.className).toContain("overflow-hidden");
    expect(screen.getByRole("log").firstElementChild?.className)
      .toContain("workbench-conversation-scroll");
    await user.click(expand);

    expect(api.setSidebarCollapsed).toHaveBeenCalledWith(false);
    expect(await screen.findByRole("button", { name: "折叠侧栏" })).toBeTruthy();
  });

  it("uses keyboard-accessible official composer controls", async () => {
    installDesktopPetMock();
    const user = userEvent.setup();
    render(<ChatPanelHarness />);

    const modelControl = await screen.findByRole("button", {
      name: "模型 MiniCPM5-1B-Q4_K_M，推理关闭",
    });
    await user.click(modelControl);
    await user.click(await screen.findByRole("menuitemradio", { name: /^高推理/ }));
    expect(screen.getByRole("button", {
      name: "模型 MiniCPM5-1B-Q4_K_M，推理高",
    })).toBeTruthy();

    const context = screen.getByRole("button", {
      name: "上下文上限 8,192 token，完成一次回答后显示用量",
    });
    await user.click(context);
    expect(await screen.findByText("上下文用量")).toBeTruthy();
  });

  it("fills a template and moves focus to the composer", async () => {
    installDesktopPetMock();
    const user = userEvent.setup();
    render(<ChatPanelHarness />);

    const composer = await screen.findByPlaceholderText("描述你想完成的任务…");
    await user.click(await screen.findByRole("button", { name: "总结这份资料" }));

    await waitFor(() => {
      expect((composer as HTMLTextAreaElement).value).toBe("总结这份资料");
      expect(document.activeElement).toBe(composer);
    });
  });

  it("integrates the local runtime state into the prompt composer", async () => {
    installDesktopPetMock();
    const loadingRuntime: RuntimeState = {
      ...runtime,
      phase: "starting",
      message: "正在加载本地 GGUF 模型",
      lastLog: "loading model tensors",
    };
    render(<ChatPanelHarness runtime={loadingRuntime} />);

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("正在加载本地 GGUF 模型");
    expect(status.closest("form")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "模型加载中" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("streams text, reasoning, tool approval and usage through ElectronChatTransport", async () => {
    const { api, emit } = installDesktopPetMock();
    const user = userEvent.setup();
    render(<ChatPanelHarness />);

    expect(await screen.findByRole("heading", { name: "今天想完成什么？" })).toBeTruthy();
    expect(screen.getByText("总结这份资料")).toBeTruthy();
    expect(screen.getByText("MiniCPM5-1B-Q4_K_M")).toBeTruthy();
    expect(screen.queryByText(/local ai/i)).toBeNull();
    expect(screen.queryByText("AI 工作台")).toBeNull();

    const composer = screen.getByPlaceholderText("描述你想完成的任务…");
    await user.type(composer, "检查项目");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(api.startChat).toHaveBeenCalledTimes(1));
    const request = api.startChat.mock.calls[0][0] as ChatRequest;
    expect(request.messages.at(-1)).toMatchObject({ role: "user", content: "检查项目" });
    expect(request.thinking).toBe(false);

    await act(async () => {
      emit({ requestId: request.requestId, type: "start" });
      emit({ requestId: request.requestId, type: "reasoning", text: "先检查配置。" });
      emit({ requestId: request.requestId, type: "delta", text: "我会先" });
      emit({
        requestId: request.requestId,
        type: "tool-call",
        call: {
          id: "tool-1",
          name: "read_file",
          displayName: "读取配置",
          arguments: "{\"path\":\"package.json\"}",
          status: "pending-approval",
          requiresApproval: true,
        },
      });
    });

    expect(await screen.findByText("读取配置")).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: "允许本次调用" }));
    await waitFor(() => expect(api.resolveToolApproval).toHaveBeenCalledWith(
      request.requestId,
      "tool-1",
      true,
    ));
    expect(api.startChat).toHaveBeenCalledTimes(1);

    await act(async () => {
      emit({
        requestId: request.requestId,
        type: "tool-result",
        toolCallId: "tool-1",
        status: "completed",
        result: "配置正常",
      });
      emit({ requestId: request.requestId, type: "delta", text: "完成。" });
      emit({
        requestId: request.requestId,
        type: "done",
        contextUsage: { promptTokens: 120, completionTokens: 20, totalTokens: 140 },
      });
    });

    const responseStart = await screen.findByText("我会先");
    const responseEnd = screen.getByText("完成。");
    expect(responseStart.compareDocumentPosition(responseEnd) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("查看思考过程")).toBeTruthy();
    expect(screen.getByRole("button", {
      name: "剩余上下文 8,052 / 8,192 token，98% 可用",
    })).toBeTruthy();
    await waitFor(() => expect(api.saveChatMessages).toHaveBeenCalled());
  });

  it("shows conversation failures through Sonner without an inline red composer error", async () => {
    const { api, emit } = installDesktopPetMock();
    const user = userEvent.setup();
    const { container } = render(<ChatPanelHarness />);

    const composer = await screen.findByPlaceholderText("描述你想完成的任务…");
    await user.type(composer, "触发错误");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(api.startChat).toHaveBeenCalledOnce());
    const request = api.startChat.mock.calls[0][0] as ChatRequest;

    await act(async () => {
      emit({ requestId: request.requestId, type: "start" });
      emit({ requestId: request.requestId, type: "error", message: "模型连接中断" });
    });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("对话出错", {
      description: "模型连接中断",
      id: "chat-error:模型连接中断",
    }));
    expect(container.querySelector('footer [role="alert"]')).toBeNull();
    expect(container.querySelector("footer .text-destructive")).toBeNull();
  });

  it("uses Radix deletion confirmation and returns focus on Escape", async () => {
    installDesktopPetMock();
    const user = userEvent.setup();
    render(<ChatPanelHarness />);
    await screen.findByText("今天想完成什么？");

    const trigger = screen.getByRole("button", { name: "管理 发布前检查" });
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: "删除对话" }));
    expect(screen.getByRole("alertdialog", { name: "删除这个对话？" })).toBeTruthy();
    expect(trigger.getAttribute("data-active")).toBe("true");
    expect(trigger.className).toContain("data-[active=true]:opacity-100");

    await user.keyboard("{Escape}");
    expect(screen.queryByText("删除 0 个对话？")).toBeNull();
    expect(screen.queryByText("批量删除")).toBeNull();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(trigger.getAttribute("data-active")).toBe("false");
  });

  it("keeps browser paste text-safe and routes attachments through Electron controls", async () => {
    const { api } = installDesktopPetMock();
    const user = userEvent.setup();
    render(<ChatPanelHarness />);

    const composer = await screen.findByPlaceholderText("描述你想完成的任务…");
    const pastedImage = new File(["image"], "clipboard.png", { type: "image/png" });
    fireEvent.paste(composer, {
      clipboardData: {
        items: [{ kind: "file", getAsFile: () => pastedImage }],
      },
    });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(api.startChat).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "添加附件" }));
    const attachmentMenu = screen.getByRole("menu");
    expect(attachmentMenu.className).toContain("min-w-52");
    expect(attachmentMenu.className).toContain("gap-1");
    expect(screen.getByRole("menuitem", { name: "上传图片" }).className).toContain("min-h-9");
    expect(screen.getByRole("menuitem", { name: "上传文本或 PDF 文档" }).className).toContain("leading-5");
    await user.click(screen.getByRole("menuitem", { name: "上传图片" }));
    expect(api.pickChatImages).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
});
