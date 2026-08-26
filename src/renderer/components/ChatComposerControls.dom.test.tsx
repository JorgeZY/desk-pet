// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeState } from "../../shared/types";
import { TooltipProvider } from "./ui/tooltip";
import { ModelReasoningControl } from "./ChatComposerControls";

const runtime: RuntimeState = {
  phase: "ready",
  visionEnabled: false,
  endpoint: "http://127.0.0.1:18766",
  message: "模型已就绪。",
  updatedAt: 1,
};

afterEach(cleanup);

describe("ModelReasoningControl", () => {
  it("defaults to off and changes reasoning strength from one model menu", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TooltipProvider>
        <ModelReasoningControl
          maxTokens={2048}
          modelLabel="Qwen3-8B"
          onChange={onChange}
          runtime={runtime}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: "模型 Qwen3-8B，推理关闭" }));
    await user.click(await screen.findByRole("menuitemradio", { name: /^极高推理/ }));
    expect(onChange).toHaveBeenLastCalledWith(true, "xhigh");
    expect(screen.getByRole("button", { name: "模型 Qwen3-8B，推理极高" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "模型 Qwen3-8B，推理极高" }));
    await user.click(await screen.findByRole("menuitemradio", { name: /^关闭推理/ }));
    expect(onChange).toHaveBeenLastCalledWith(false, "xhigh");
  });
});
