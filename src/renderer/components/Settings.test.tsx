// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../main/config-store";
import type { ChatToolDefinition, EmbeddingState, RuntimeState, SpeechState, TtsState } from "../../shared/types";
import { normalizeNumericDraft, Settings } from "./Settings";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
  },
}));

const runtime: RuntimeState = {
  phase: "ready",
  visionEnabled: false,
  endpoint: "http://127.0.0.1:18766",
  message: "模型已就绪。",
  updatedAt: 1,
};

const embedding: EmbeddingState = {
  enabled: true,
  phase: "ready",
  endpoint: "http://127.0.0.1:18767",
  modelPath: "D:\\models\\Qwen3-Embedding-0.6B-Q8_0.gguf",
  message: "向量模型已就绪。",
  indexedChunkCount: 0,
  pendingChunkCount: 0,
  embeddingDimension: 1024,
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

const defaultTools: ChatToolDefinition[] = [
  {
    id: "builtin__time",
    displayName: "time",
    source: "builtin",
    requiresApproval: false,
  },
  {
    id: "mcp__files__read",
    displayName: "files · read",
    source: "mcp",
    requiresApproval: true,
  },
];

function installDesktopPetMock(tools: ChatToolDefinition[] = defaultTools) {
  const api = {
    listRuntimeTools: vi.fn().mockResolvedValue(tools),
    pickModel: vi.fn().mockResolvedValue(null),
    pickEmbeddingModel: vi.fn().mockResolvedValue(null),
    pickMmproj: vi.fn().mockResolvedValue(null),
    pickMcpServersConfig: vi.fn().mockResolvedValue(null),
    listKnowledgeDocuments: vi.fn().mockResolvedValue([]),
    importKnowledgeDocuments: vi.fn().mockResolvedValue(null),
    deleteKnowledgeDocument: vi.fn().mockResolvedValue([]),
    getWorkbenchWindowState: vi.fn().mockResolvedValue({
      maximized: false,
      sidebarCollapsed: false,
    }),
    onWorkbenchWindowState: vi.fn().mockReturnValue(() => undefined),
    setSidebarCollapsed: vi.fn().mockResolvedValue(undefined),
  };
  Object.defineProperty(window, "desktopPet", {
    configurable: true,
    value: api,
  });
  return api;
}

function renderSettings(overrides: Partial<ComponentProps<typeof Settings>> = {}) {
  const props: ComponentProps<typeof Settings> = {
    initialConfig: { ...DEFAULT_CONFIG, chatTemplates: ["模板甲", "", "模板丙"] },
    runtime,
    embedding,
    speech,
    tts,
    embedded: true,
    onClose: vi.fn(),
    onSave: vi.fn().mockResolvedValue(undefined),
    onPrepareEmbedding: vi.fn().mockResolvedValue(undefined),
    onStopEmbedding: vi.fn().mockResolvedValue(undefined),
    onReindexKnowledge: vi.fn().mockResolvedValue(undefined),
    onPrepareSpeech: vi.fn().mockResolvedValue(undefined),
    onImportSpeech: vi.fn().mockResolvedValue(undefined),
    onPrepareTts: vi.fn().mockResolvedValue(undefined),
    onImportTts: vi.fn().mockResolvedValue(undefined),
    onSpeakText: vi.fn().mockResolvedValue(undefined),
    onStopSpeaking: vi.fn().mockResolvedValue(undefined),
    onOpenCaption: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { ...render(<Settings {...props} />), props };
}

beforeEach(() => {
  vi.clearAllMocks();
  installDesktopPetMock();
  if (!globalThis.ResizeObserver) {
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  }
  HTMLElement.prototype.scrollIntoView ??= vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Settings", () => {
  it("uses six keyboard-accessible settings categories", async () => {
    const user = userEvent.setup();
    renderSettings();

    expect(screen.getByRole("tablist", { name: "设置分类" })).toBeTruthy();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "模型",
      "Agent",
      "工具与 MCP",
      "知识库",
      "语音",
      "外观",
    ]);
    expect(screen.getByText("本地模型")).toBeTruthy();

    const modelTab = screen.getByRole("tab", { name: "模型" });
    modelTab.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("tab", { name: "Agent" }).getAttribute("data-state")).toBe("active");

    await user.click(screen.getByRole("tab", { name: "工具与 MCP" }));
    expect(screen.getByRole("tabpanel").textContent).toContain("MCP Servers 配置");
    expect(screen.queryByText("本地模型")).toBeNull();
    expect(await screen.findByText("files · read")).toBeTruthy();
    expect(screen.getByText("调用需确认")).toBeTruthy();
  });

  it("keeps the category rail full-height with icons and visible controls", () => {
    renderSettings();

    const tablist = screen.getByRole("tablist", { name: "设置分类" });
    expect(tablist.getAttribute("data-variant")).toBe("soft");
    expect(tablist.className).toContain("group-data-[orientation=vertical]/tabs:h-full");
    expect(tablist.className).toContain("bg-sidebar");
    expect(screen.getAllByRole("tab").every((tab) => tab.querySelector("svg"))).toBe(true);
    expect(screen.getByRole("tab", { name: "模型" }).className).toContain(
      "data-[state=active]:bg-sidebar-accent",
    );
    expect(screen.getByRole("tab", { name: "模型" }).className).toContain(
      "data-[state=active]:border-primary/55",
    );
    expect(screen.getByRole("tab", { name: "模型" }).className).toContain(
      "inset_0_1px_0_var(--ui-control-highlight)",
    );
    expect(screen.getByRole("tab", { name: "模型" }).className).not.toContain(
      "translate-y",
    );
    expect(screen.getByRole("tab", { name: "模型" }).className).not.toContain(
      "scale-[",
    );
    expect(screen.getByRole("tab", { name: "模型" }).className).toContain("after:hidden");
    expect(screen.getAllByRole("tab").every((tab) => tab.className.includes("flex-none"))).toBe(true);
    expect(screen.getByRole("button", { name: "取消" }).getAttribute("data-variant")).toBe("outline");
  });

  it("persists the compact sidebar from the appearance category", async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(screen.getByRole("tab", { name: "外观" }));
    await user.click(screen.getByRole("switch", { name: "紧凑侧栏" }));

    expect(window.desktopPet.setSidebarCollapsed).toHaveBeenCalledWith(true);
    expect(screen.getByText("跟随 Windows 系统")).toBeTruthy();
  });

  it("keeps parameter help accessible in the active model and voice tabs", async () => {
    const user = userEvent.setup();
    renderSettings();

    for (const label of [
      "上下文",
      "GPU 层数",
      "CPU 线程",
      "最大输出",
      "温度",
      "端口",
      "Top K",
      "Top P",
      "Min P",
      "重复惩罚",
      "存在惩罚",
    ]) {
      expect(screen.getByRole("button", { name: `${label}参数说明` })).toBeTruthy();
      expect(screen.getByRole("switch", { name: `自定义${label}` })).toBeTruthy();
    }
    expect(screen.getByRole("textbox", { name: "上下文" })).toBeTruthy();
    await user.hover(screen.getByRole("button", { name: "上下文参数说明" }));
    expect((await screen.findByRole("tooltip")).textContent).toContain("最大 token 数");

    await user.click(screen.getByRole("tab", { name: "语音" }));
    expect(screen.getByRole("button", { name: "语速参数说明" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "音色编号参数说明" })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: "语速" })).toBeTruthy();
  });

  it("reports dirty state and saves edited Agent settings without closing", async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderSettings({ onDirtyChange, onSave });

    await user.click(screen.getByRole("tab", { name: "Agent" }));
    const prompt = screen.getByLabelText("系统提示词");
    await user.clear(prompt);
    await user.type(prompt, "新的 Agent 设定");

    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    await user.click(screen.getByRole("button", { name: "仅保存" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ systemPrompt: "新的 Agent 设定" }),
      false,
    ));
    expect(toast.success).toHaveBeenCalledWith("设置已保存", {
      description: "需要时可继续保存并重启模型。",
    });
    expect(screen.getByRole("tab", { name: "Agent" }).getAttribute("data-state")).toBe("active");
  });

  it("disables an individual model parameter without losing its saved draft", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderSettings({ onSave });

    const contextInput = screen.getByRole("textbox", { name: "上下文" }) as HTMLInputElement;
    expect(contextInput.disabled).toBe(false);
    expect(contextInput.value).toBe("8192");

    await user.click(screen.getByRole("switch", { name: "自定义上下文" }));
    expect(contextInput.disabled).toBe(true);
    expect(contextInput.value).toBe("8192");
    await user.click(screen.getByRole("button", { name: "仅保存" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        modelParameterOverrides: expect.objectContaining({ contextSize: false }),
      }),
      false,
    ));
  });

  it("controls tool sources and individual tools through persisted settings", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderSettings({ onSave });

    await user.click(screen.getByRole("tab", { name: "工具与 MCP" }));
    const builtinSwitch = screen.getByRole("switch", { name: "启用内置工具" });
    const mcpSwitch = screen.getByRole("switch", { name: "启用 MCP 工具" });
    const mcpToolSwitch = await screen.findByRole("switch", { name: "启用工具 files · read" });

    expect(builtinSwitch.getAttribute("data-state")).toBe("checked");
    expect(mcpSwitch.getAttribute("data-state")).toBe("checked");
    await user.click(mcpToolSwitch);
    await user.click(screen.getByRole("button", { name: "仅保存" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        toolSettings: expect.objectContaining({ disabledToolIds: ["mcp__files__read"] }),
      }),
      false,
    ));

    await user.click(mcpSwitch);
    expect((screen.getByRole("switch", { name: "启用工具 files · read" }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it("refreshes the runtime tool inventory after saving without a restart", async () => {
    const user = userEvent.setup();
    const refreshedTool: ChatToolDefinition = {
      id: "mcp__git__status",
      displayName: "git · status",
      source: "mcp",
      requiresApproval: true,
    };
    const api = installDesktopPetMock();
    api.listRuntimeTools
      .mockResolvedValueOnce(defaultTools)
      .mockResolvedValueOnce([refreshedTool]);
    api.pickMcpServersConfig.mockResolvedValue({
      path: "D:\\mcp-next.json",
      name: "mcp-next.json",
    });
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderSettings({ onSave });

    await user.click(screen.getByRole("tab", { name: "工具与 MCP" }));
    expect(await screen.findByRole("switch", { name: "启用工具 files · read" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "选择 JSON" }));
    await user.click(screen.getByRole("button", { name: "仅保存" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ mcpServersConfigPath: "D:\\mcp-next.json" }),
      false,
    ));
    expect(await screen.findByRole("switch", { name: "启用工具 git · status" })).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole("switch", { name: "启用工具 files · read" })).toBeNull();
      expect(api.listRuntimeTools).toHaveBeenCalledTimes(2);
    });
  });

  it("loads, disables, and removes local knowledge without deleting the source file", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const document = {
      id: "knowledge-1",
      path: "D:\\docs\\机器人材料.md",
      name: "机器人材料.md",
      mimeType: "text/plain" as const,
      characterCount: 1_234,
      chunkCount: 3,
      createdAt: 1,
      updatedAt: 1,
    };
    vi.mocked(window.desktopPet.listKnowledgeDocuments).mockResolvedValue([document]);
    vi.mocked(window.desktopPet.deleteKnowledgeDocument).mockResolvedValue([]);
    renderSettings({ onSave });

    await user.click(screen.getByRole("tab", { name: "知识库" }));
    expect(await screen.findByText("机器人材料.md")).toBeTruthy();
    expect(screen.getByText(/1,234 字符 · 3 个片段/)).toBeTruthy();
    await user.click(screen.getByRole("switch", { name: "启用本地知识库" }));
    await user.click(screen.getByRole("button", { name: "移除知识库文档 机器人材料.md" }));
    await waitFor(() => expect(window.desktopPet.deleteKnowledgeDocument)
      .toHaveBeenCalledWith("knowledge-1"));
    expect(await screen.findByText("知识库为空，可导入文本或 PDF 文档。")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "仅保存" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        toolSettings: expect.objectContaining({ knowledgeEnabled: false }),
      }),
      false,
    ));
    expect(toast.success).toHaveBeenCalledWith("已从知识库移除文档", {
      description: "原始文件没有被删除。",
    });
  });

  it("closes settings only after save-and-restart succeeds", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderSettings({ onClose, onSave });

    await user.click(screen.getByRole("button", { name: "保存并重启模型" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.any(Object), true));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows progress only on the settings action that is running", async () => {
    const user = userEvent.setup();
    let finishSave: (() => void) | undefined;
    const onSave = vi.fn(() => new Promise<void>((resolve) => {
      finishSave = resolve;
    }));
    renderSettings({ onSave });

    await user.click(screen.getByRole("button", { name: "仅保存" }));

    expect(screen.getByRole("button", { name: "保存中…" })).toBeTruthy();
    const restartButton = screen.getByRole("button", { name: "保存并重启模型" });
    expect(restartButton).toBeTruthy();
    expect(restartButton.getAttribute("aria-disabled")).toBe("true");
    expect((restartButton as HTMLButtonElement).disabled).toBe(false);
    expect(restartButton.className).toContain("pointer-events-none");
    expect(restartButton.className).toContain("w-40");
    expect(screen.getByRole("button", { name: "保存中…" }).className).toContain("w-24");
    expect(screen.queryByRole("button", { name: "保存并重启中…" })).toBeNull();

    finishSave?.();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "仅保存" })).toBeTruthy();
    });
  });

  it("numbers settings sections independently inside each category", async () => {
    const user = userEvent.setup();
    renderSettings();

    const indices = () => within(screen.getByRole("tabpanel"))
      .getAllByText(/^0[12]$/)
      .map((node) => node.textContent);

    expect(indices()).toEqual(["01", "02"]);
    await user.click(screen.getByRole("tab", { name: "Agent" }));
    expect(indices()).toEqual(["01", "02"]);
    await user.click(screen.getByRole("tab", { name: "工具与 MCP" }));
    expect(indices()).toEqual(["01"]);
    await user.click(screen.getByRole("tab", { name: "知识库" }));
    expect(indices()).toEqual(["01", "02"]);
    await user.click(screen.getByRole("tab", { name: "语音" }));
    expect(indices()).toEqual(["01", "02"]);
    await user.click(screen.getByRole("tab", { name: "外观" }));
    expect(indices()).toEqual(["01"]);
  });

  it("keeps three editable templates and the combined local-speech control", async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(screen.getByRole("tab", { name: "Agent" }));
    expect((screen.getByLabelText("模板 1") as HTMLInputElement).value).toBe("模板甲");
    expect(screen.getByLabelText("模板 2").getAttribute("maxlength")).toBe("80");
    expect((screen.getByLabelText("模板 3") as HTMLInputElement).value).toBe("模板丙");

    await user.click(screen.getByRole("tab", { name: "语音" }));
    expect(screen.getByText("同时启用聊天框麦克风与全局 F8 按住说话")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "启用本地语音输入" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "启用语音朗读" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开实时字幕" })).toBeTruthy();
  });

  it("normalizes numeric drafts only when committed", () => {
    expect(normalizeNumericDraft("", 0, 0, 999, true)).toBe(0);
    expect(normalizeNumericDraft("1", 0, 0, 999, true)).toBe(1);
    expect(normalizeNumericDraft("01", 0, 0, 999, true)).toBe(1);
    expect(normalizeNumericDraft("-0.5", 0, -2, 2)).toBe(-0.5);
    expect(normalizeNumericDraft("9", 0, -2, 2)).toBe(2);
  });
});
