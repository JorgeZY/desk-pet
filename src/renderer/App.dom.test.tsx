// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../main/config-store";
import type { BootstrapData, WindowMode } from "../shared/types";
import { App } from "./App";

vi.mock("./components/ChatPanel", () => ({
  ChatPanel: ({
    activePage,
    settingsContent,
  }: {
    activePage: "chat" | "settings";
    settingsContent?: ReactNode;
  }) => (
    <main data-testid="workbench" data-page={activePage}>
      {settingsContent}
    </main>
  ),
}));

vi.mock("./components/Settings", () => ({
  Settings: ({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) => (
    <button type="button" onClick={() => onDirtyChange?.(true)}>
      修改设置
    </button>
  ),
}));

vi.mock("./components/Onboarding", () => ({
  Onboarding: () => <main>onboarding</main>,
}));

vi.mock("./components/Pet", () => ({
  Pet: () => <div>pet</div>,
}));

const bootstrap: BootstrapData = {
  config: { ...DEFAULT_CONFIG, setupComplete: true },
  runtime: {
    phase: "ready",
    visionEnabled: false,
    endpoint: "http://127.0.0.1:18766",
    message: "模型已就绪。",
    updatedAt: 1,
  },
  speech: {
    enabled: true,
    phase: "ready",
    message: "语音模型已就绪。",
    modelDirectory: "D:\\models\\speech",
    updatedAt: 1,
  },
  tts: {
    enabled: true,
    phase: "ready",
    message: "语音朗读模型已就绪。",
    modelDirectory: "D:\\models\\tts",
    updatedAt: 1,
  },
  caption: {
    phase: "ready",
    message: "实时字幕未启动。",
    modelDirectory: "D:\\models\\speech",
    partial: "",
    segments: [],
    updatedAt: 1,
  },
  platform: "win32",
  appVersion: "test",
};

let openViewListener: ((mode: WindowMode) => void) | undefined;
let bootstrapListener: ((data: BootstrapData) => void) | undefined;

beforeEach(() => {
  window.history.replaceState({}, "", "/?window=workbench&view=settings");
  openViewListener = undefined;
  bootstrapListener = undefined;
  Object.defineProperty(window, "desktopPet", {
    configurable: true,
    value: {
      getBootstrap: vi.fn().mockResolvedValue(bootstrap),
      onBootstrap: vi.fn((listener: (data: BootstrapData) => void) => {
        bootstrapListener = listener;
        return () => undefined;
      }),
      onRuntimeState: vi.fn().mockReturnValue(() => undefined),
      onPrepareQuit: vi.fn().mockReturnValue(() => undefined),
      onSpeechState: vi.fn().mockReturnValue(() => undefined),
      onTtsState: vi.fn().mockReturnValue(() => undefined),
      onSpeechEvent: vi.fn().mockReturnValue(() => undefined),
      onOpenView: vi.fn((listener: (mode: WindowMode) => void) => {
        openViewListener = listener;
        return () => undefined;
      }),
      notifyViewReady: vi.fn(),
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("App main-process view navigation", () => {
  it("refreshes a pre-created pet renderer after onboarding completes", async () => {
    window.history.replaceState({}, "", "/?window=pet&view=pet");
    vi.mocked(window.desktopPet.getBootstrap).mockResolvedValueOnce({
      ...bootstrap,
      config: { ...bootstrap.config, setupComplete: false },
    });
    render(<App />);

    expect(await screen.findByText("onboarding")).toBeTruthy();

    act(() => bootstrapListener?.(bootstrap));

    expect(await screen.findByText("pet")).toBeTruthy();
  });

  it("renders a self-contained workbench error state without pet-only classes", async () => {
    vi.mocked(window.desktopPet.getBootstrap).mockRejectedValueOnce(
      new Error("bootstrap failed"),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: "工作台启动失败" })).toBeTruthy();
    expect(screen.getByText("bootstrap failed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试" }).className).toContain("bg-primary");
    expect(document.querySelector(".fatal-error")).toBeNull();
  });

  it("confirms before an app:open-view event leaves dirty settings", async () => {
    const user = userEvent.setup();
    const confirmDiscard = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<App />);

    expect((await screen.findByTestId("workbench")).getAttribute("data-page")).toBe("settings");
    const listenerCountBeforeEdit = vi.mocked(window.desktopPet.onOpenView).mock.calls.length;
    await user.click(screen.getByRole("button", { name: "修改设置" }));
    await waitFor(() => {
      expect(vi.mocked(window.desktopPet.onOpenView).mock.calls.length).toBeGreaterThan(
        listenerCountBeforeEdit,
      );
    });

    act(() => openViewListener?.("chat"));

    expect(confirmDiscard).toHaveBeenCalledWith("设置尚未保存，确定要放弃这些修改吗？");
    expect(screen.getByTestId("workbench").getAttribute("data-page")).toBe("settings");

    confirmDiscard.mockReturnValue(true);
    act(() => openViewListener?.("chat"));

    await waitFor(() => {
      expect(screen.getByTestId("workbench").getAttribute("data-page")).toBe("chat");
    });
  });
});
