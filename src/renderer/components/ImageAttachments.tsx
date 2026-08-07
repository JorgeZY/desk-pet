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
      aria-label={images.length ? `重新上传图片，当前 ${images.length} 张` : "上传图片"}
      title={disabled ? "请先在设置中选择视觉投影模型" : "上传图片（最多 4 张，合计不超过 10 MB）"}
    >
      <svg className="image-attach-button__icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 15V4m0 0L8 8m4-4 4 4M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14" />
      </svg>
      {!compact && <span className="image-attach-button__label">上传</span>}
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
