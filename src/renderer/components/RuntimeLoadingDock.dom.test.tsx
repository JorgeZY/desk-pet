// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeState } from "../../shared/types";
import { RuntimeLoadingDock, formatBytes } from "./RuntimeLoadingDock";

const startingRuntime: RuntimeState = {
  phase: "starting",
  visionEnabled: false,
  endpoint: "http://127.0.0.1:18766",
  message: "正在加载本地 GGUF 模型",
  lastLog: "llama_model_loader: loading model tensors",
  updatedAt: 1,
};

afterEach(cleanup);

describe("RuntimeLoadingDock", () => {
  it("uses an indeterminate rail without inventing GGUF loading progress", () => {
    render(
      <RuntimeLoadingDock
        modelLabel="MiniCPM5-1B-Q4_K_M"
        onStart={vi.fn()}
        runtime={startingRuntime}
      />,
    );

    expect(screen.getByRole("status").textContent).toContain("正在加载本地 GGUF 模型");
    expect(screen.getByText(/MiniCPM5-1B-Q4_K_M/)).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "模型加载中" }).getAttribute("data-mode"))
      .toBe("indeterminate");
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it("shows real download progress and runtime details", async () => {
    const user = userEvent.setup();
    render(
      <RuntimeLoadingDock
        modelLabel="MiniCPM5-1B-Q4_K_M"
        onStart={vi.fn()}
        runtime={{
          ...startingRuntime,
          phase: "downloading",
          message: "正在下载模型",
          download: {
            source: "modelscope",
            receivedBytes: 512 * 1024 * 1024,
            totalBytes: 2 * 1024 * 1024 * 1024,
            percent: 25,
          },
        }}
      />,
    );

    expect(screen.getByRole("progressbar", { name: "模型下载进度" }).getAttribute("aria-valuenow"))
      .toBe("25");
    expect(screen.getByText(/512 MB \/ 2.00 GB/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "查看模型加载详情" }));
    expect(await screen.findByText("本地运行时详情")).toBeTruthy();
    expect(screen.getByText("http://127.0.0.1:18766")).toBeTruthy();
    expect(screen.getByText("modelscope")).toBeTruthy();
  });

  it("keeps failures inline and exposes an accessible retry action", async () => {
    const onStart = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <RuntimeLoadingDock
        modelLabel="MiniCPM5-1B-Q4_K_M"
        onStart={onStart}
        runtime={{
          ...startingRuntime,
          phase: "error",
          message: "模型启动失败",
          error: "无法打开 GGUF 文件",
        }}
      />,
    );

    expect(screen.queryByRole("progressbar")).toBeNull();
    await user.click(screen.getByRole("button", { name: "启动模型" }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("formats byte quantities for compact status text", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.50 KB");
    expect(formatBytes(undefined)).toBeUndefined();
  });
});
