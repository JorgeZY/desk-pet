// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../main/config-store";
import { Onboarding } from "./Onboarding";

function installDesktopPetMock() {
  const api = {
    pickExecutable: vi.fn().mockResolvedValue(null),
    probeRuntime: vi.fn().mockResolvedValue({
      ok: true,
      executable: "llama",
      version: "llama.cpp test",
    }),
    pickModel: vi.fn().mockResolvedValue(null),
    openExternal: vi.fn(),
  };
  Object.defineProperty(window, "desktopPet", {
    configurable: true,
    value: api,
  });
  return api;
}

async function reachModelStep(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.click(screen.getByRole("button", { name: "检测 llama.cpp" }));
  await screen.findByText("运行时可用");
  await user.click(screen.getByRole("button", { name: "继续" }));
}

beforeEach(() => {
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

describe("Onboarding", () => {
  it("starts as a four-step shadcn card without pet imagery or a drag strip", () => {
    installDesktopPetMock();
    const { container } = render(
      <Onboarding initialConfig={DEFAULT_CONFIG} platform="win32" onComplete={vi.fn()} />,
    );

    expect(screen.getByRole("heading", { name: "欢迎使用团子" })).toBeTruthy();
    const progress = screen.getByRole("progressbar", { name: "第 1 步，共 4 步" });
    expect(progress.getAttribute("aria-valuenow")).toBe("25");
    expect(screen.getByText("一个真正运行在本机的 AI 助手")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".pet")).toBeNull();
    expect(container.querySelector(".window-drag-strip")).toBeNull();
  });

  it("preserves runtime validation and submits the configured fourth step", async () => {
    installDesktopPetMock();
    const user = userEvent.setup();
    const onComplete = vi.fn().mockResolvedValue(undefined);
    render(<Onboarding initialConfig={DEFAULT_CONFIG} platform="win32" onComplete={onComplete} />);

    await reachModelStep(user);
    expect(screen.getByRole("heading", { name: "选择端侧模型" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "继续" }));

    expect(screen.getByRole("heading", { name: "调整本地运行参数" })).toBeTruthy();
    const gpuLayers = screen.getByRole("spinbutton", { name: "GPU 卸载层数" }) as HTMLInputElement;
    await user.clear(gpuLayers);
    await user.type(gpuLayers, "42");
    await user.click(screen.getByRole("switch", { name: "开机后自动准备模型" }));
    await user.click(screen.getByRole("button", { name: "完成并启动" }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
      setupComplete: true,
      gpuLayers: 42,
      autoStart: false,
    })));
  });

  it("requires a GGUF path when local model mode is selected", async () => {
    const api = installDesktopPetMock();
    api.pickModel.mockResolvedValue({ path: "D:\\models\\local.gguf", name: "local.gguf" });
    const user = userEvent.setup();
    render(<Onboarding initialConfig={DEFAULT_CONFIG} platform="win32" onComplete={vi.fn()} />);

    await reachModelStep(user);
    await user.click(screen.getByRole("radio", { name: "本地 GGUF" }));
    const continueButton = screen.getByRole("button", { name: "继续" }) as HTMLButtonElement;
    expect(continueButton.disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: "选择" }));
    await waitFor(() => expect(continueButton.disabled).toBe(false));
    expect((screen.getByLabelText("llama.cpp 支持的 GGUF 文件") as HTMLInputElement).value).toBe("D:\\models\\local.gguf");
  });
});
