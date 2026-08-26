// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./code-block", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
}));

import { Tool, ToolHeader, ToolOutput } from "./tool";

afterEach(cleanup);

describe("ToolOutput", () => {
  it.each([false, 0, ""])("keeps falsy output %j visible", (output) => {
    render(
      <ToolOutput
        data-testid="tool-output"
        errorText={undefined}
        output={output}
      />
    );

    expect(screen.getByTestId("tool-output")).toBeTruthy();
    expect(screen.getByText("结果")).toBeTruthy();
  });

  it("omits the output section only when output and error are nullish", () => {
    const { container } = render(
      <ToolOutput errorText={undefined} output={undefined} />
    );

    expect(container.firstChild).toBeNull();
  });

  it("pads tool errors away from the result boundary", () => {
    render(<ToolOutput errorText="工具调用被拒绝" output={undefined} />);

    const error = screen.getByText("工具调用被拒绝");
    expect(error.className).toContain("px-3");
    expect(error.className).toContain("py-2.5");
    expect(error.className).toContain("leading-relaxed");
  });
});

describe("ToolHeader", () => {
  it("keeps status controls fixed while allowing long titles to truncate", () => {
    render(
      <Tool>
        <ToolHeader
          state="output-available"
          title="A tool title that must fit inside a narrow message column"
          type="dynamic-tool"
          toolName="test-tool"
        />
      </Tool>
    );

    const title = screen.getByText(
      "A tool title that must fit inside a narrow message column"
    );
    const titleRow = title.parentElement;
    const status = screen.getByText("已完成");

    expect(title.className).toContain("min-w-0");
    expect(title.className).toContain("truncate");
    expect(titleRow?.className).toContain("min-w-0");
    expect(status?.className).toContain("shrink-0");
  });
});
