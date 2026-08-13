export type PixelIconName =
  | "settings"
  | "close"
  | "arrow-up"
  | "stop"
  | "open"
  | "mic"
  | "dot"
  | "upload"
  | "image"
  | "bolt"
  | "sparkle"
  | "history"
  | "plus"
  | "trash";

interface PixelIconProps {
  name: PixelIconName;
  className?: string;
}

const ICON_PATHS = {
  settings: "M1 3h3V1h4v2h7v2H8v2H4V5H1V3Zm0 8h8V9h4v2h2v2h-2v2H9v-2H1v-2Z",
  close: "M2 2h2v2H2V2Zm10 0h2v2h-2V2ZM4 4h2v2H4V4Zm6 0h2v2h-2V4ZM6 6h4v4H6V6Zm-2 4h2v2H4v-2Zm6 0h2v2h-2v-2Zm-8 2h2v2H2v-2Zm10 0h2v2h-2v-2Z",
  "arrow-up": "M7 2h2v2h2v2h2v2h-3V7H9v7H7V7H6v1H3V6h2V4h2V2Z",
  stop: "M3 3h10v10H3V3Z",
  open: "M2 5h5v2H4v5h5V9h2v5H2V5ZM8 2h6v6h-2V5h-2v2H8v2H6V7h2V5h2V4H8V2Z",
  mic: "M6 0h4v1h1v8h-1v2H6V9H5V1h1V0ZM2 6h2v4h2v1h4v-1h2V6h2v5h-2v2H9v2h3v1H4v-1h3v-2H4v-2H2V6Z",
  dot: "M6 5h4v1h1v4h-1v1H6v-1H5V6h1V5Z",
  upload: "M7 1h2v2h2v2h2v2h-3V6H9v6H7V6H6v1H3V5h2V3h2V1ZM2 10h2v3h8v-3h2v5H2v-5Z",
  image: "M2 2h12v12H2V2Zm2 2v8h8V4H4Zm1 6 2-2 2 2 1-1 2 2v1H4v-1l1-1Zm5-4h1v1h-1V6Z",
  bolt: "M8 1h4v4h-2v2h3v2h-2v2H9v2H7v2H4v-4h2V9H3V6h2V4h3V1Z",
  sparkle: "M7 1h2v4h2v2h4v2h-4v2H9v4H7v-4H5V9H1V7h4V5h2V1Zm6 10h1v1h1v1h-1v1h-1v-1h-1v-1h1v-1Z",
  history: "M3 2h10v2H3V2ZM2 5h12v9H2V5Zm2 2v5h8V7H4Zm2 1h4v2H6V8Z",
  plus: "M7 2h2v5h5v2H9v5H7V9H2V7h5V2Z",
  trash: "M5 1h6v2h3v2H2V3h3V1ZM3 6h10v9H3V6Zm3 2v5h1V8H6Zm3 0v5h1V8H9Z",
} satisfies Record<PixelIconName, string>;

export function PixelIcon({ name, className }: PixelIconProps) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
      data-pixel-icon={name}
    >
      <path d={ICON_PATHS[name]} fillRule="evenodd" />
    </svg>
  );
}
