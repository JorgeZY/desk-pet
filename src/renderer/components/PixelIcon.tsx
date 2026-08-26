import {
  ArrowUp,
  ChevronDown,
  Circle,
  Copy,
  Download,
  Eraser,
  ExternalLink,
  FileText,
  History,
  Captions,
  Cat,
  Image,
  Maximize2,
  Mic,
  Minimize2,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Square,
  StepForward,
  Trash2,
  Upload,
  Volume2,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";

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
  | "document"
  | "bolt"
  | "sparkle"
  | "history"
  | "plus"
  | "minus"
  | "clear"
  | "play"
  | "download"
  | "trash"
  | "volume"
  | "refresh"
  | "copy"
  | "continue"
  | "chevron-down"
  | "captions"
  | "cat"
  | "maximize"
  | "restore"
  | "sidebar-close"
  | "sidebar-open";

interface PixelIconProps {
  name: PixelIconName;
  className?: string;
}

const LUCIDE_ICONS: Record<PixelIconName, LucideIcon> = {
  settings: SlidersHorizontal,
  close: X,
  "arrow-up": ArrowUp,
  stop: Square,
  open: ExternalLink,
  mic: Mic,
  dot: Circle,
  upload: Upload,
  image: Image,
  document: FileText,
  bolt: Zap,
  sparkle: Sparkles,
  history: History,
  plus: Plus,
  minus: Minus,
  clear: Eraser,
  play: Play,
  download: Download,
  trash: Trash2,
  volume: Volume2,
  refresh: RefreshCw,
  copy: Copy,
  continue: StepForward,
  "chevron-down": ChevronDown,
  captions: Captions,
  cat: Cat,
  maximize: Maximize2,
  restore: Minimize2,
  "sidebar-close": PanelLeftClose,
  "sidebar-open": PanelLeftOpen,
};

export function PixelIcon({ name, className }: PixelIconProps) {
  const Icon = LUCIDE_ICONS[name];
  return (
    <Icon
      className={className}
      size={18}
      strokeWidth={2.2}
      aria-hidden="true"
      focusable="false"
      data-lucide-icon={name}
    />
  );
}
