"""Build the desktop pet's deterministic mood GIF clips from RGBA keyframes.

Requires Pillow. Runtime code never executes this script; Electron consumes only
the generated files under src/renderer/public/pet/moods.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Iterable, Sequence

from PIL import Image, ImageChops, ImageEnhance


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

ACTION_SHEET_PATHS = {
    "thinking": SOURCE / "pet-soft-pixel-thinking-sheet-v1.png",
    "talking": SOURCE / "pet-soft-pixel-talking-sheet-v1.png",
    "sleeping": SOURCE / "pet-soft-pixel-sleeping-sheet-v1.png",
    "listening": SOURCE / "pet-soft-pixel-listening-sheet-v1.png",
    "yawning": SOURCE / "pet-soft-pixel-yawn-sheet-v1.png",
    "ear_scratching": SOURCE / "pet-soft-pixel-ear-scratch-sheet-v1.png",
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


def load_action_frames(
    path: Path,
    target_frame: Image.Image,
) -> list[Image.Image]:
    """Split a 2x2 action sheet and register every pose to the resting pet."""
    target_bbox = target_frame.getchannel("A").getbbox()
    if target_bbox is None:
        raise ValueError("Target pet frame has no visible pixels")
    sheet = Image.open(path).convert("RGBA")
    slot_width = sheet.width // 2
    slot_height = sheet.height // 2
    slots = [
        sheet.crop((0, 0, slot_width, slot_height)),
        sheet.crop((slot_width, 0, slot_width * 2, slot_height)),
        sheet.crop((0, slot_height, slot_width, slot_height * 2)),
        sheet.crop((slot_width, slot_height, slot_width * 2, slot_height * 2)),
    ]
    boxes = [slot.getchannel("A").getbbox() for slot in slots]
    if any(box is None for box in boxes):
        raise ValueError(f"Action sheet contains a blank slot: {path}")

    visible_boxes = [box for box in boxes if box is not None]
    union = (
        min(box[0] for box in visible_boxes),
        min(box[1] for box in visible_boxes),
        max(box[2] for box in visible_boxes),
        max(box[3] for box in visible_boxes),
    )
    union_width = union[2] - union[0]
    union_height = union[3] - union[1]
    target_height = target_bbox[3] - target_bbox[1]
    scale = min((CANVAS[0] - 16) / union_width, target_height / union_height)
    render_size = (
        max(1, round(union_width * scale)),
        max(1, round(union_height * scale)),
    )
    target_bottom = target_bbox[3]

    frames: list[Image.Image] = []
    for slot in slots:
        cropped = slot.crop(union).resize(render_size, Image.Resampling.LANCZOS)
        canvas = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
        alpha_composite_at(
            canvas,
            cropped,
            round((CANVAS[0] - render_size[0]) / 2),
            target_bottom - render_size[1],
        )
        frames.append(canvas)
    return register_action_frames(frames, target_frame)


def lower_body_anchor(image: Image.Image) -> tuple[float, int]:
    """Locate the grounded lower torso/paws without letting ears or tails steer it."""
    alpha = image.getchannel("A")
    bbox = alpha.getbbox()
    if bbox is None:
        raise ValueError("Cannot register a blank action frame")

    left, top, right, bottom = bbox
    visible_width = right - left
    visible_height = bottom - top
    band_top = bottom - max(24, round(visible_height * 0.22))
    center_left = left + round(visible_width * 0.25)
    center_right = right - round(visible_width * 0.25)
    pixels = alpha.load()
    grounded = [
        (x, y)
        for y in range(band_top, bottom)
        for x in range(center_left, center_right)
        if pixels[x, y] >= ALPHA_THRESHOLD
    ]
    if not grounded:
        raise ValueError("Action frame has no grounded lower-body pixels")
    return sum(x for x, _ in grounded) / len(grounded), max(y for _, y in grounded)


def translate_frame(image: Image.Image, dx: int, dy: int) -> Image.Image:
    translated = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
    alpha_composite_at(translated, image, dx, dy)
    return translated


def register_action_frames(
    frames: Sequence[Image.Image],
    target_frame: Image.Image,
) -> list[Image.Image]:
    """Keep the paws/lower torso fixed while the upper-body action changes."""
    target_x, target_y = lower_body_anchor(target_frame)
    registered: list[Image.Image] = []
    for frame in frames:
        anchor_x, anchor_y = lower_body_anchor(frame)
        registered.append(
            translate_frame(
                frame,
                round(target_x - anchor_x),
                target_y - anchor_y,
            )
        )
    return registered


def normalize_upright_action_frames(
    frames: Sequence[Image.Image],
    target_frame: Image.Image,
) -> list[Image.Image]:
    """Match upright generated poses to the resting pet's height and paw anchor."""
    target_bbox = target_frame.getchannel("A").getbbox()
    if target_bbox is None:
        raise ValueError("Target pet frame has no visible pixels")
    target_height = target_bbox[3] - target_bbox[1]
    target_x, target_y = lower_body_anchor(target_frame)
    normalized: list[Image.Image] = []

    for frame in frames:
        bbox = frame.getchannel("A").getbbox()
        if bbox is None:
            raise ValueError("Cannot normalize a blank action frame")
        left, top, right, bottom = bbox
        scale = target_height / (bottom - top)
        crop = frame.crop(bbox)
        resized = crop.resize(
            (max(1, round(crop.width * scale)), target_height),
            Image.Resampling.LANCZOS,
        )
        anchor_x, anchor_y = lower_body_anchor(frame)
        anchor_offset_x = (anchor_x - left) * scale
        anchor_offset_y = (anchor_y - top) * scale
        canvas = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
        alpha_composite_at(
            canvas,
            resized,
            round(target_x - anchor_offset_x),
            round(target_y - anchor_offset_y),
        )
        normalized_bbox = canvas.getchannel("A").getbbox()
        normalized_x, normalized_y = lower_body_anchor(canvas)
        if (
            normalized_bbox is None
            or abs((normalized_bbox[3] - normalized_bbox[1]) - target_height) > 1
            or abs(normalized_x - target_x) > 2
            or abs(normalized_y - target_y) > 2
        ):
            raise ValueError("Upright action frame drifted away from the resting body anchor")
        normalized.append(canvas)

    return normalized


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


def require_matching_loop_endpoints(name: str, frames: Sequence[Image.Image]) -> None:
    """Prevent a looping action from jumping when it wraps or returns to idle."""
    if len(frames) < 2 or ImageChops.difference(frames[0], frames[-1]).getbbox() is not None:
        raise ValueError(f"{name} must start and end on the exact same resting frame")


def load_gif_frames(path: Path) -> list[Image.Image]:
    """Decode the shipped GIF so validation covers palette conversion as well."""
    image = Image.open(path)
    frames: list[Image.Image] = []
    for index in range(image.n_frames):
        image.seek(index)
        frames.append(image.convert("RGBA").copy())
    return frames


def validate_upright_loop_output(name: str) -> None:
    """Guard the action-neutral seam, pose symmetry, scale, and baseline."""
    idle_frame = load_gif_frames(OUTPUT / "pet-idle-v1.gif")[0]
    frames = load_gif_frames(OUTPUT / f"pet-{name}-v1.gif")
    if len(frames) < 3 or len(frames) % 2 == 0:
        raise ValueError(f"{name} must contain an odd neutral-to-action loop")
    if ImageChops.difference(frames[0], frames[-1]).getbbox() is not None:
        raise ValueError(f"{name} decoded endpoints must use one action-neutral frame")
    mirrored_pose_index = len(frames) - 2
    if ImageChops.difference(frames[1], frames[mirrored_pose_index]).getbbox() is not None:
        raise ValueError(f"{name} decoded poses must return symmetrically to rest")

    idle_alpha = idle_frame.getchannel("A")
    idle_bbox = idle_alpha.getbbox()
    if idle_bbox is None:
        raise ValueError("Decoded idle frame has no visible pixels")
    idle_area = sum(
        value >= ALPHA_THRESHOLD for value in idle_alpha.get_flattened_data()
    )
    idle_bottom = idle_bbox[3]
    neutral_bbox = frames[0].getchannel("A").getbbox()
    if neutral_bbox is None:
        raise ValueError(f"{name} decoded neutral frame has no visible pixels")
    neutral_width_ratio = (
        (neutral_bbox[2] - neutral_bbox[0]) / (idle_bbox[2] - idle_bbox[0])
    )
    neutral_height_ratio = (
        (neutral_bbox[3] - neutral_bbox[1]) / (idle_bbox[3] - idle_bbox[1])
    )
    neutral_anchor_x, neutral_anchor_y = lower_body_anchor(frames[0])
    idle_anchor_x, idle_anchor_y = lower_body_anchor(idle_frame)
    if not 0.96 <= neutral_width_ratio <= 1.05:
        raise ValueError(f"{name} action-neutral width does not match idle")
    if not 0.975 <= neutral_height_ratio <= 1.025:
        raise ValueError(f"{name} action-neutral height does not match idle")
    if (
        abs(neutral_anchor_x - idle_anchor_x) > 2
        or abs(neutral_anchor_y - idle_anchor_y) > 2
    ):
        raise ValueError(f"{name} action-neutral lower body is not aligned with idle")
    action_heights: list[int] = []
    for frame in frames:
        alpha = frame.getchannel("A")
        bbox = alpha.getbbox()
        if bbox is None:
            raise ValueError(f"{name} contains a blank decoded frame")
        area = sum(
            value >= ALPHA_THRESHOLD for value in alpha.get_flattened_data()
        )
        area_ratio = area / idle_area
        if not 0.88 <= area_ratio <= 1.10:
            raise ValueError(
                f"{name} decoded visual volume drifted to {area_ratio:.3f} of idle"
            )
        if abs(bbox[3] - idle_bottom) > 2:
            raise ValueError(f"{name} decoded baseline drifted away from idle")
        action_heights.append(bbox[3] - bbox[1])

    if (
        name == "listening"
        and ImageChops.difference(frames[0], frames[2]).getbbox() is not None
    ):
        raise ValueError("listening must return to its upright neutral pose on frame three")

    action_heights = action_heights[1:-1]
    if max(action_heights) - min(action_heights) > 6:
        raise ValueError(f"{name} decoded action height changes too much during its loop")


def main() -> None:
    keyframes = load_keyframes()
    base = keyframes["base"]
    happy = keyframes["happy"]
    thinking_keyframes = normalize_upright_action_frames(
        load_action_frames(ACTION_SHEET_PATHS["thinking"], base),
        base,
    )
    talking_keyframes = normalize_upright_action_frames(
        load_action_frames(ACTION_SHEET_PATHS["talking"], base),
        base,
    )
    sleeping_keyframes = load_action_frames(ACTION_SHEET_PATHS["sleeping"], base)
    listening_keyframes = normalize_upright_action_frames(
        load_action_frames(ACTION_SHEET_PATHS["listening"], base),
        base,
    )
    yawning_keyframes = load_action_frames(
        ACTION_SHEET_PATHS["yawning"],
        base,
    )
    ear_scratching_keyframes = load_action_frames(
        ACTION_SHEET_PATHS["ear_scratching"],
        base,
    )

    idle = breathe_frames(base, 20, lift=2.2, stretch=0.0032, sway=0.06)
    idle[15] = transform_pose(happy, dy=-1)
    idle_durations = [235] * len(idle)
    idle_durations[15] = IDLE_BLINK_DURATION_MS

    thinking = [
        thinking_keyframes[3],
        thinking_keyframes[1],
        thinking_keyframes[2],
        thinking_keyframes[1],
        thinking_keyframes[3],
    ]
    thinking_durations = [200, 650, 3_100, 650, 200]

    talking = [
        talking_keyframes[0],
        talking_keyframes[1],
        talking_keyframes[2],
        talking_keyframes[1],
        talking_keyframes[2],
        talking_keyframes[1],
        talking_keyframes[3],
    ]
    talking_durations = [180, 170, 240, 140, 220, 160, 220]

    sleeping = [
        sleeping_keyframes[0],
        sleeping_keyframes[1],
        sleeping_keyframes[2],
        sleeping_keyframes[3],
        sleeping_keyframes[2],
        sleeping_keyframes[3],
        sleeping_keyframes[1],
    ]
    sleeping_durations = [300, 450, 1100, 750, 900, 750, 450]

    sad_source = tint_sad(base)
    sad = breathe_frames(sad_source, 18, lift=0.7, stretch=0.0014, sway=0.05)
    sad = [transform_pose(frame, dy=2) for frame in sad]

    listening = [
        listening_keyframes[3],
        listening_keyframes[1],
        listening_keyframes[3],
        listening_keyframes[1],
        listening_keyframes[3],
    ]
    listening_durations = [250, 900, 1_650, 900, 700]
    require_matching_loop_endpoints("thinking", thinking)
    require_matching_loop_endpoints("listening", listening)

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

    yawning = [
        base,
        yawning_keyframes[0],
        yawning_keyframes[1],
        yawning_keyframes[2],
        yawning_keyframes[1],
        yawning_keyframes[3],
        base,
    ]
    yawning_durations = [300, 180, 240, 520, 360, 260, 700]

    ear_scratching = [
        base,
        ear_scratching_keyframes[0],
        ear_scratching_keyframes[1],
        ear_scratching_keyframes[2],
        ear_scratching_keyframes[1],
        ear_scratching_keyframes[2],
        ear_scratching_keyframes[1],
        ear_scratching_keyframes[3],
        base,
    ]
    ear_scratching_durations = [280, 160, 180, 260, 180, 260, 180, 200, 800]

    # Keep the established shared palette stable so adding an action does not
    # rewrite every existing mood GIF.
    palette = build_palette(keyframes.values())
    save_gif("idle", idle, idle_durations, palette)
    save_gif("thinking", thinking, thinking_durations, palette)
    save_gif("talking", talking, talking_durations, palette)
    save_gif("sleeping", sleeping, sleeping_durations, palette)
    save_gif("sad", sad, 190, palette)
    save_gif("listening", listening, listening_durations, palette)
    save_gif("transcribing", transcribing, 150, palette)
    save_gif("grooming", grooming, grooming_durations, palette, loop=False)
    save_gif("yawning", yawning, yawning_durations, palette, loop=False)
    save_gif(
        "ear-scratching",
        ear_scratching,
        ear_scratching_durations,
        palette,
        loop=False,
    )
    validate_upright_loop_output("thinking")
    validate_upright_loop_output("listening")


if __name__ == "__main__":
    main()
