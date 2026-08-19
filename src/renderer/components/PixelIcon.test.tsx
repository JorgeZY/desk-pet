import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImageAttachmentTray } from "./ImageAttachments";
import { PixelIcon, type PixelIconName } from "./PixelIcon";
import { VoiceButton } from "./VoiceButton";

const ICONS: PixelIconName[] = [
  "settings",
  "close",
  "arrow-up",
  "stop",
  "open",
  "mic",
  "dot",
  "upload",
  "image",
  "bolt",
  "sparkle",
  "refresh",
  "chevron-down",
];

describe("PixelIcon", () => {
  it.each(ICONS)("renders the %s icon on a crisp 16px grid", (name) => {
    const markup = renderToStaticMarkup(<PixelIcon name={name} />);

    expect(markup).toContain('width="16"');
    expect(markup).toContain('height="16"');
    expect(markup).toContain('viewBox="0 0 16 16"');
    expect(markup).toContain(`shape-rendering="${name === "refresh" || name === "chevron-down" ? "geometricPrecision" : "crispEdges"}"`);
    expect(markup).toContain(`data-pixel-icon="${name}"`);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("<path");
    if (name !== "refresh") expect(markup).not.toMatch(/\d\.\d/u);
  });

  it.each(["refresh", "chevron-down"] satisfies PixelIconName[])("renders %s as a clean outlined icon", (name) => {
    const markup = renderToStaticMarkup(<PixelIcon name={name} />);

    expect(markup).toContain('fill="none"');
    expect(markup).toContain('stroke="currentColor"');
    expect(markup).toContain('stroke-linecap="round"');
    expect(markup).toContain('stroke-linejoin="round"');
  });

  it("renders a clear clockwise refresh arc with a separate solid arrowhead", () => {
    const markup = renderToStaticMarkup(<PixelIcon name="refresh" />);

    expect(markup).toContain('d="M12.4 8.7A5.1 5.1 0 1 1 10.5 3.8"');
    expect(markup).toContain('d="M10.7 1.5 14.4 5.5 9.1 6.5Z"');
    expect(markup).toContain('stroke-width="2.2"');
    expect(markup).toContain('fill="currentColor" stroke="none"');
  });

  it("exposes stable centering hooks for attachment removal", () => {
    const markup = renderToStaticMarkup(
      <ImageAttachmentTray
        images={[{ path: "C:/cat.png", name: "cat.png", mimeType: "image/png" }]}
        onRemove={() => undefined}
      />,
    );

    expect(markup).toContain("image-attachment-tray");
    expect(markup).toContain("image-attachment__remove");
    expect(markup).toContain("image-attachment__remove-icon");
    expect(markup).toContain('aria-label="移除 cat.png"');
  });

  it("renders the microphone SVG as the centered button item", () => {
    const markup = renderToStaticMarkup(
      <VoiceButton
        speech={{
          enabled: true,
          phase: "ready",
          message: "语音输入已就绪。",
          modelDirectory: "C:/models/speech",
          updatedAt: 1,
        }}
        compact
        onPrepare={async () => undefined}
        onStart={async () => undefined}
        onStop={async () => undefined}
      />,
    );

    expect(markup).toContain('class="voice-button__icon"');
    expect(markup).toContain('data-pixel-icon="mic"');
    expect(markup).not.toContain('<span class="voice-button__icon"');
  });
});
