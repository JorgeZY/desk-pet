// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  PromptInput,
  PromptInputBody,
  PromptInputSubmit,
  PromptInputTextarea,
} from "./prompt-input";

describe("PromptInput native-host attachment mode", () => {
  it("does not intercept browser paste or drop when Electron owns attachments", () => {
    const { container } = render(
      <TooltipProvider>
        <PromptInput attachmentsEnabled={false} onSubmit={vi.fn()}>
          <PromptInputBody>
            <PromptInputTextarea aria-label="任务" defaultValue="保留文字" />
          </PromptInputBody>
          <PromptInputSubmit status="ready" />
        </PromptInput>
      </TooltipProvider>,
    );
    const textarea = screen.getByRole("textbox", { name: "任务" });
    expect(textarea.className).toContain("workbench-composer-scroll");
    expect(textarea.className).toContain("me-1.5");
    expect(textarea.className).toContain("w-[calc(100%_-_0.375rem)]");
    const pastedImage = new File(["image"], "clipboard.png", { type: "image/png" });
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: {
        items: [{ kind: "file", getAsFile: () => pastedImage }],
      },
    });

    textarea.dispatchEvent(pasteEvent);
    expect(pasteEvent.defaultPrevented).toBe(false);

    const dropEvent = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: { files: [pastedImage], types: ["Files"] },
    });
    container.querySelector("form")?.dispatchEvent(dropEvent);
    expect(dropEvent.defaultPrevented).toBe(false);
    expect(container.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(true);
    expect((textarea as HTMLTextAreaElement).value).toBe("保留文字");
  });
});
