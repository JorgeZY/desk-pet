import type { ChatImage } from "../../shared/types";

interface ImageAttachButtonProps {
  images: ChatImage[];
  disabled?: boolean;
  compact?: boolean;
  onChange: (images: ChatImage[]) => void;
  onError: (message: string) => void;
}

export function ImageAttachButton({
  images,
  disabled = false,
  compact = false,
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

  return (
    <button
      className={`image-attach-button ${compact ? "image-attach-button--compact" : ""}`}
      type="button"
      onClick={() => void pick()}
      disabled={disabled}
      aria-label={images.length ? `重新选择图片，当前 ${images.length} 张` : "添加图片"}
      title={disabled ? "请先在设置中选择视觉投影模型" : "添加图片（最多 4 张）"}
    >
      <span aria-hidden="true">▧</span>
      {images.length > 0 && <b>{images.length}</b>}
    </button>
  );
}

interface ImageAttachmentTrayProps {
  images: ChatImage[];
  onRemove?: (index: number) => void;
  compact?: boolean;
}

export function ImageAttachmentTray({ images, onRemove, compact = false }: ImageAttachmentTrayProps) {
  if (!images.length) return null;
  return (
    <div className={`image-attachment-tray ${compact ? "image-attachment-tray--compact" : ""}`}>
      {images.map((image, index) => (
        <figure className="image-attachment" key={`${image.path}-${index}`} title={image.name}>
          {image.previewUrl ? (
            <img src={image.previewUrl} alt={image.name} />
          ) : (
            <span aria-hidden="true">▧</span>
          )}
          <figcaption>{image.name}</figcaption>
          {onRemove && (
            <button type="button" onClick={() => onRemove(index)} aria-label={`移除 ${image.name}`}>×</button>
          )}
        </figure>
      ))}
    </div>
  );
}
