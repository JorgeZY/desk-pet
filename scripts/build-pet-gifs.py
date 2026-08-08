"""Build the desktop pet's deterministic mood GIF clips from RGBA keyframes.

Requires Pillow. Runtime code never executes this script; Electron consumes only
the generated files under src/renderer/public/pet/moods.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Iterable, Sequence

from PIL import Image, ImageEnhance


ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "src" / "renderer" / "public"
SOURCE = ROOT / "assets" / "pet-source"
OUTPUT = PUBLIC / "pet" / "moods"
CANVAS = (432, 540)
ALPHA_THRESHOLD = 48
PALETTE_COLORS = 192
IDLE_BLINK_DURATION_MS = 160

SOURCE_PATHS = {
    "base": PUBLIC / "pet-soft-pixel-v1.png",
    "happy": SOURCE / "pet-soft-pixel-happy-v1.png",
    "groom_mid": SOURCE / "pet-soft-pixel-groom-mid-v1.png",
    "groom_lift": SOURCE / "pet-soft-pixel-groom-lift-v1.png",
    "groom_lick": SOURCE / "pet-soft-pixel-groom-lick-v1.png",
}


def alpha_composite_at(canvas: Image.Image, source: Image.Image, x: int, y: int) -> None:
    left = max(0, -x)
    top = max(0, -y)
    right = min(source.width, canvas.width - x)
    bottom = min(source.height, canvas.height - y)
    if right <= left or bottom <= top:
        return
    crop = source.crop((left, top, right, bottom))
    canvas.alpha_composite(crop, (max(0, x), max(0, y)))


def load_aligned(path: Path, target_bbox: tuple[float, float, float, float]) -> Image.Image:
    source = Image.open(path).convert("RGBA")
    bbox = source.getchannel("A").getbbox()
    if bbox is None:
        raise ValueError(f"No visible pixels in {path}")

    left, top, right, bottom = bbox
    target_left, target_top, target_right, target_bottom = target_bbox
    visible_width = (right - left) / source.width
    visible_height = (bottom - top) / source.height
    render_width = (target_right - target_left) / visible_width
    render_height = (target_bottom - target_top) / visible_height
    render_x = target_left - (left / source.width) * render_width
    render_y = target_top - (top / source.height) * render_height

    resized = source.resize(
        (max(1, round(render_width)), max(1, round(render_height))),
        Image.Resampling.LANCZOS,
    )
    canvas = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
    alpha_composite_at(canvas, resized, round(render_x), round(render_y))
    return canvas


def load_keyframes() -> dict[str, Image.Image]:
    base_source = Image.open(SOURCE_PATHS["base"]).convert("RGBA")
    base_bbox = base_source.getchannel("A").getbbox()
    if base_bbox is None:
        raise ValueError("Base pet image has no visible pixels")
    left, top, right, bottom = base_bbox
    target_bbox = (
        left / base_source.width * CANVAS[0],
        top / base_source.height * CANVAS[1],
        right / base_source.width * CANVAS[0],
        bottom / base_source.height * CANVAS[1],
    )
    return {name: load_aligned(path, target_bbox) for name, path in SOURCE_PATHS.items()}


def transform_pose(
    image: Image.Image,
    *,
    dx: int = 0,
    dy: int = 0,
    scale_x: float = 1.0,
    scale_y: float = 1.0,
    angle: float = 0.0,
) -> Image.Image:
    width = max(1, round(CANVAS[0] * scale_x))
    height = max(1, round(CANVAS[1] * scale_y))
    scaled = image.resize((width, height), Image.Resampling.BICUBIC)
    canvas = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
    x = round((CANVAS[0] - width) / 2) + dx
    y = CANVAS[1] - height + dy
    alpha_composite_at(canvas, scaled, x, y)
    if angle:
        canvas = canvas.rotate(
            angle,
            resample=Image.Resampling.BICUBIC,
            center=(CANVAS[0] / 2, CANVAS[1] - 18),
        )
    return canvas


def breathe_frames(
    source: Image.Image,
    count: int,
    *,
    lift: float,
    stretch: float,
    sway: float = 0.0,
    horizontal: float = 0.0,
) -> list[Image.Image]:
    frames: list[Image.Image] = []
    for index in range(count):
        progress = index / max(1, count - 1)
        breath = (1 - math.cos(progress * math.tau)) / 2
        wave = math.sin(progress * math.tau)
        frames.append(
            transform_pose(
                source,
                dx=round(horizontal * wave),
                dy=round(-lift * breath),
                scale_y=1 + stretch * breath,
                angle=sway * wave,
            )
        )
    return frames


def tint_sad(image: Image.Image) -> Image.Image:
    return ImageEnhance.Brightness(
        ImageEnhance.Color(image).enhance(0.72),
    ).enhance(0.96)


def build_palette(images: Iterable[Image.Image]) -> Image.Image:
    prepared: list[Image.Image] = []
    for image in images:
        rgb = Image.new("RGB", CANVAS, (238, 146, 55))
        rgb.paste(image.convert("RGB"), mask=image.getchannel("A"))
        prepared.append(rgb)
    atlas = Image.new("RGB", (CANVAS[0], CANVAS[1] * len(prepared)))
    for index, image in enumerate(prepared):
        atlas.paste(image, (0, index * CANVAS[1]))
    quantized = atlas.quantize(
        colors=PALETTE_COLORS,
        method=Image.Quantize.MEDIANCUT,
        dither=Image.Dither.NONE,
    )
    colors = (quantized.getpalette() or [])[: PALETTE_COLORS * 3]
    fill = colors[-3:] if colors else [238, 146, 55]
    palette = [0, 255, 0, *colors]
    while len(palette) < 768:
        palette.extend(fill)
    palette_image = Image.new("P", (1, 1))
    palette_image.putpalette(palette[:768])
    return palette_image


def index_frame(frame: Image.Image, palette: Image.Image) -> Image.Image:
    rgb = Image.new("RGB", CANVAS, (0, 255, 0))
    alpha = frame.getchannel("A")
    rgb.paste(frame.convert("RGB"), mask=alpha)
    indexed = rgb.quantize(palette=palette, dither=Image.Dither.NONE)
    transparent = alpha.point(lambda value: 255 if value < ALPHA_THRESHOLD else 0)
    indexed.paste(0, mask=transparent)
    indexed.info["transparency"] = 0
    return indexed


def save_gif(
    name: str,
    frames: Sequence[Image.Image],
    durations: Sequence[int] | int,
    palette: Image.Image,
    *,
    loop: bool = True,
) -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    indexed = [index_frame(frame, palette) for frame in frames]
    kwargs = {
        "save_all": True,
        "append_images": indexed[1:],
        "duration": durations,
        "disposal": 2,
        "transparency": 0,
        "optimize": False,
    }
    if loop:
        kwargs["loop"] = 0
    output = OUTPUT / f"pet-{name}-v1.gif"
    indexed[0].save(output, **kwargs)
    print(f"Wrote {output.relative_to(ROOT)} ({output.stat().st_size / 1024:.1f} KiB)")


def main() -> None:
    keyframes = load_keyframes()
    base = keyframes["base"]
    happy = keyframes["happy"]

    idle = breathe_frames(base, 20, lift=2.2, stretch=0.0032, sway=0.06)
    idle[15] = transform_pose(happy, dy=-1)
    idle_durations = [235] * len(idle)
    idle_durations[15] = IDLE_BLINK_DURATION_MS

    thinking = breathe_frames(base, 16, lift=2.0, stretch=0.002, sway=0.32, horizontal=1.0)

    talking = breathe_frames(base, 10, lift=3.2, stretch=0.002, sway=0.14)
    talking[4] = transform_pose(happy, dy=-2)

    sleeping = breathe_frames(happy, 18, lift=1.0, stretch=0.0038, sway=0.04)

    sad_source = tint_sad(base)
    sad = breathe_frames(sad_source, 18, lift=0.7, stretch=0.0014, sway=0.05)
    sad = [transform_pose(frame, dy=2) for frame in sad]

    listening = breathe_frames(base, 12, lift=3.0, stretch=0.0018, sway=0.12)

    transcribing = breathe_frames(base, 16, lift=1.2, stretch=0.0015, sway=0.04)

    grooming = [
        base,
        keyframes["groom_mid"],
        keyframes["groom_lift"],
        keyframes["groom_lick"],
        keyframes["groom_lift"],
        keyframes["groom_lick"],
        keyframes["groom_lift"],
        keyframes["groom_lick"],
        keyframes["groom_lift"],
        keyframes["groom_mid"],
        base,
    ]
    grooming_durations = [300, 180, 380, 180, 260, 210, 230, 170, 340, 200, 450]

    palette = build_palette(keyframes.values())
    save_gif("idle", idle, idle_durations, palette)
    save_gif("thinking", thinking, 150, palette)
    save_gif("talking", talking, 110, palette)
    save_gif("sleeping", sleeping, 200, palette)
    save_gif("sad", sad, 190, palette)
    save_gif("listening", listening, 130, palette)
    save_gif("transcribing", transcribing, 150, palette)
    save_gif("grooming", grooming, grooming_durations, palette, loop=False)


if __name__ == "__main__":
    main()
