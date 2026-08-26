import type { ChatImage } from "../../shared/types";
import { Button } from "@/components/ui/button";
import {
  PromptInputActionMenuItem,
  PromptInputButton,
} from "./ai-elements/prompt-input";
import { PixelIcon } from "./PixelIcon";

interface ImageAttachButtonProps {
  images: ChatImage[];
  disabled?: boolean;
  disabledReason?: string;
  menuItem?: boolean;
  onChange: (images: ChatImage[]) => void;
  onError: (message: string) => void;
}

export function ImageAttachButton({
  images,
  disabled = false,
  disabledReason,
  menuItem = false,
  onChange,
  onError,
}: ImageAttachButtonProps) {
  const pick = async () => {
    onError("");
    try {
      const selected = await window.desktopPet.pickChatImages();
      if (selected.length) onChange(selected);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  const label = images.length ? `重新上传图片，当前 ${images.length} 张` : "上传图片";
  const tooltip = disabled
    ? disabledReason ?? "当前无法上传图片"
    : "上传图片（最多 4 张，合计不超过 10 MB）";
  const content = (
    <>
      <PixelIcon name="image" className="image-attach-button__icon" />
      {images.length > 0 && <b>{images.length}</b>}
      {menuItem ? <span>上传图片</span> : null}
    </>
  );

  if (menuItem) {
    return (
      <PromptInputActionMenuItem
        aria-label={label}
        disabled={disabled}
        onSelect={() => {
          void pick();
        }}
        title={tooltip}
      >
        {content}
      </PromptInputActionMenuItem>
    );
  }

  return (
    <PromptInputButton
      aria-label={label}
      disabled={disabled}
      onClick={() => void pick()}
      tooltip={tooltip}
    >
      {content}
    </PromptInputButton>
  );
}

interface ImageAttachmentTrayProps {
  images: ChatImage[];
  onRemove?: (index: number) => void;
}

export function ImageAttachmentTray({ images, onRemove }: ImageAttachmentTrayProps) {
  if (!images.length) return null;
  return (
    <div className="flex flex-wrap gap-2" aria-label="已选择的图片">
      {images.map((image, index) => (
        <figure
          className="group relative m-0 size-16 overflow-hidden rounded-lg border bg-muted"
          key={`${image.path}-${index}`}
          title={image.name}
        >
          {image.previewUrl ? (
            <img className="size-full object-cover" src={image.previewUrl} alt={image.name} />
          ) : (
            <span className="grid size-full place-items-center text-muted-foreground" aria-hidden="true">
              <PixelIcon name="image" />
            </span>
          )}
          <figcaption className="sr-only">{image.name}</figcaption>
          {onRemove && (
            <Button
              className="absolute right-1 top-1 size-6 bg-card/90 opacity-0 shadow-sm group-hover:opacity-100 group-focus-within:opacity-100"
              type="button"
              onClick={() => onRemove(index)}
              aria-label={`移除 ${image.name}`}
              size="icon-xs"
              variant="ghost"
            >
              <PixelIcon name="close" />
            </Button>
          )}
        </figure>
      ))}
    </div>
  );
}
