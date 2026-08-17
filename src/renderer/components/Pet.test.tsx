import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PET_CLIPS, resolvePetVisualState } from "./pet-clips";
import { Pet, type PetMood } from "./Pet";

const moods = [
  "idle",
  "thinking",
  "talking",
  "sleeping",
  "sad",
  "listening",
  "transcribing",
] as const satisfies readonly PetMood[];

describe("Pet", () => {
  it("renders non-interactive artwork without a focusable button", () => {
    const markup = renderToStaticMarkup(<Pet mood="sleeping" compact />);

    expect(markup).toContain("pet--decorative");
    expect(markup).toContain("mood-sleeping");
    expect(markup).toContain('src="./pet/moods/pet-sleeping-v1.gif?rev=');
    expect(markup).toContain('alt="橘猫团子，正在休息"');
    expect(markup).not.toContain("<button");
  });

  it("exposes the main pet as the chat action and keeps the drag affordance", () => {
    const markup = renderToStaticMarkup(
      <Pet mood="idle" windowDrag onClick={() => undefined} />,
    );

    expect(markup).toContain("<button");
    expect(markup).toContain('type="button"');
    expect(markup).toContain('aria-label="打开团子对话"');
    expect(markup).toContain('src="./pet/moods/pet-idle-v1.gif"');
    expect(markup).toContain('alt=""');
    expect(markup).toContain("pet__drag-zone");

    const buttonEnd = markup.indexOf("</button>");
    const dragStart = markup.indexOf("pet__drag-zone");
    expect(buttonEnd).toBeGreaterThan(-1);
    expect(dragStart).toBeGreaterThan(buttonEnd);
  });

  it("does not create a drag hot spot when window dragging is disabled", () => {
    const markup = renderToStaticMarkup(
      <Pet mood="idle" onClick={() => undefined} />,
    );

    expect(markup).toContain("pet--interactive");
    expect(markup).not.toContain("pet__drag-zone");
  });

  it("uses one GIF clip with independent mood overlays", () => {
    const markup = renderToStaticMarkup(<Pet mood="listening" compact />);

    expect(markup).toContain("pet__canvas");
    expect(markup).toContain("pet-ground-layer");
    expect(markup).toContain("pet-state-layer");
    expect(markup).toContain("pet-clip--listening");
    expect(markup).toContain(`src="${PET_CLIPS.listening.src}"`);
    expect(markup).toContain('viewBox="0 0 96 120"');
    expect(markup).toContain("pet-ground-response");
    expect(markup).toContain("thought-dots");
    expect(markup).toContain("pet-talk-marks");
    expect(markup).toContain("voice-wave--outer");
    expect(markup).toContain("pet-listen-bell");
    expect(markup).toContain("transcribe-card__paper");
    expect(markup).toContain("pet-sleep-zs");
    expect(markup).toContain("pet-sad-tear");
    expect(markup).toContain("<ellipse");
    expect(markup.match(/<img/g)).toHaveLength(1);
    expect(markup).not.toContain("pet-frame--open");
    expect(markup).not.toContain("pet-soft-pixel-happy-v1.png");
  });

  it("keeps listening effects while the pet body uses the idle clip", () => {
    const markup = renderToStaticMarkup(
      <Pet mood="listening" clipMood="idle" compact />,
    );

    expect(markup).toContain("mood-listening");
    expect(markup).toContain("clip-idle");
    expect(markup).toContain(`src="${PET_CLIPS.idle.src}"`);
    expect(markup).not.toContain(`src="${PET_CLIPS.listening.src}"`);
    expect(markup).toContain("voice-wave--outer");
    expect(markup).toContain("pet-listen-bell");
  });

  it("offsets the talking marks away from the pet body", () => {
    const markup = renderToStaticMarkup(<Pet mood="talking" compact />);

    expect(markup).toContain(
      'class="pet-talk-marks" transform="translate(6 -1)"',
    );
  });

  it.each(moods)("maps the %s mood to its dedicated GIF", (mood) => {
    const markup = renderToStaticMarkup(<Pet mood={mood} />);

    expect(markup).toContain(`mood-${mood}`);
    expect(markup).toContain(`clip-${mood}`);
    expect(markup).toContain(`src="${PET_CLIPS[mood].src.replaceAll("&", "&amp;")}"`);
    expect(markup).toContain("橘猫团子");
  });

  it("allows an idle action to replace idle but never a business mood", () => {
    expect(resolvePetVisualState("idle", "grooming")).toBe("grooming");
    expect(resolvePetVisualState("idle", "yawning")).toBe("yawning");
    expect(resolvePetVisualState("idle", "ear-scratching")).toBe("ear-scratching");
    expect(resolvePetVisualState("idle", "daydreaming")).toBe("daydreaming");
    expect(resolvePetVisualState("idle", "cheering")).toBe("cheering");
    expect(resolvePetVisualState("idle", "dozing")).toBe("dozing");
    expect(resolvePetVisualState("idle", "perking-up")).toBe("perking-up");
    expect(resolvePetVisualState("thinking", "yawning")).toBe("thinking");
    expect(resolvePetVisualState("listening", "ear-scratching")).toBe("listening");
    expect(resolvePetVisualState("transcribing", "grooming")).toBe("transcribing");
  });
});
