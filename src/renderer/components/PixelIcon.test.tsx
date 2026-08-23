import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImageAttachButton, ImageAttachmentTray } from "./ImageAttachments";
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
  "document",
  "bolt",
  "sparkle",
  "history",
  "plus",
  "minus",
  "clear",
  "play",
  "download",
  "trash",
  "volume",
  "refresh",
  "copy",
  "continue",
  "chevron-down",
];

describe("PixelIcon", () => {
  it.each(ICONS)("renders %s from Lucide at the shared large size", (name) => {
    const markup = renderToStaticMarkup(<PixelIcon name={name} />);

    expect(markup).toContain('class="lucide lucide-');
    expect(markup).toContain('width="18"');
    expect(markup).toContain('height="18"');
    expect(markup).toContain('viewBox="0 0 24 24"');
    expect(markup).toContain('fill="none"');
    expect(markup).toContain('stroke="currentColor"');
    expect(markup).toContain('stroke-width="2.2"');
    expect(markup).toContain(`data-lucide-icon="${name}"`);
    expect(markup).toContain('aria-hidden="true"');
  });

  it("maps refresh and continue to the standard Lucide symbols", () => {
    const refresh = renderToStaticMarkup(<PixelIcon name="refresh" />);
    const continuation = renderToStaticMarkup(<PixelIcon name="continue" />);

    expect(refresh).toContain("lucide-refresh-cw");
    expect(continuation).toContain("lucide-step-forward");
  });

  it("uses the Lucide image symbol for the image attachment button", () => {
    const markup = renderToStaticMarkup(
      <ImageAttachButton
        images={[]}
        onChange={() => undefined}
        onError={() => undefined}
      />,
    );

    expect(markup).toContain('data-lucide-icon="image"');
    expect(markup).toContain("lucide-image");
  });

  it("keeps attachment removal icons centered through the shared hook", () => {
    const markup = renderToStaticMarkup(
      <ImageAttachmentTray
        images={[{ path: "C:/cat.png", name: "cat.png", mimeType: "image/png" }]}
        onRemove={() => undefined}
      />,
    );

    expect(markup).toContain("image-attachment__remove-icon");
    expect(markup).toContain('data-lucide-icon="close"');
    expect(markup).toContain('aria-label="移除 cat.png"');
  });

  it("renders the Lucide microphone as the centered compact button item", () => {
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

    expect(markup).toContain("lucide-mic");
    expect(markup).toContain("voice-button__icon");
    expect(markup).toContain('data-lucide-icon="mic"');
  });
});
