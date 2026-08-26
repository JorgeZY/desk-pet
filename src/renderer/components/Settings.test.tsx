// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../main/config-store";
import type { ChatToolDefinition, RuntimeState, SpeechState, TtsState } from "../../shared/types";
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

const defaultTools: ChatToolDefinition[] = [{
  id: "mcp__files__read",
  displayName: "files · read",
  source: "mcp",
  requiresApproval: true,
}];

function installDesktopPetMock(tools: ChatToolDefinition[] = defaultTools): void {
  Object.defineProperty(window, "desktopPet", {
    configurable: true,
    value: {
      listRuntimeTools: vi.fn().mockResolvedValue(tools),
      pickModel: vi.fn().mockResolvedValue(null),
      pickMmproj: vi.fn().mockResolvedValue(null),
      pickMcpServersConfig: vi.fn().mockResolvedValue(null),
      getWorkbenchWindowState: vi.fn().mockResolvedValue({
        maximized: false,
        sidebarCollapsed: false,
      }),
      onWorkbenchWindowState: vi.fn().mockReturnValue(() => undefined),
      setSidebarCollapsed: vi.fn().mockResolvedValue(undefined),
    },
  });
}

function renderSettings(overrides: Partial<ComponentProps<typeof Settings>> = {}) {
  const props: ComponentProps<typeof Settings> = {
    initialConfig: { ...DEFAULT_CONFIG, chatTemplates: ["模板甲", "", "模板丙"] },
    runtime,
    speech,
    tts,
    embedded: true,
    onClose: vi.fn(),
    onSave: vi.fn().mockResolvedValue(undefined),
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
  it("uses five keyboard-accessible settings categories", async () => {
    const user = userEvent.setup();
    renderSettings();

    expect(screen.getByRole("tablist", { name: "设置分类" })).toBeTruthy();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "模型",
      "Agent",
      "工具与 MCP",
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
