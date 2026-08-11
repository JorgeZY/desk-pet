import type { ChatImage } from "../../shared/types";
import { PixelIcon } from "./PixelIcon";

interface ImageAttachButtonProps {
  images: ChatImage[];
  disabled?: boolean;
  onChange: (images: ChatImage[]) => void;
  onError: (message: string) => void;
}

export function ImageAttachButton({
  images,
  disabled = false,
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
      className="image-attach-button"
      type="button"
      onClick={() => void pick()}
      disabled={disabled}
      aria-label={images.length ? `重新上传图片，当前 ${images.length} 张` : "上传图片"}
      title={disabled ? "请先在设置中选择视觉投影模型" : "上传图片（最多 4 张，合计不超过 10 MB）"}
    >
      <PixelIcon name="upload" className="image-attach-button__icon" />
      {images.length > 0 && <b>{images.length}</b>}
    </button>
  );
}

interface ImageAttachmentTrayProps {
  images: ChatImage[];
  onRemove?: (index: number) => void;
}

export function ImageAttachmentTray({ images, onRemove }: ImageAttachmentTrayProps) {
  if (!images.length) return null;
  return (
    <div className="image-attachment-tray">
      {images.map((image, index) => (
        <figure className="image-attachment" key={`${image.path}-${index}`} title={image.name}>
          {image.previewUrl ? (
            <img src={image.previewUrl} alt={image.name} />
          ) : (
            <span aria-hidden="true"><PixelIcon name="image" /></span>
          )}
          <figcaption>{image.name}</figcaption>
          {onRemove && (
            <button
              className="image-attachment__remove"
              type="button"
              onClick={() => onRemove(index)}
              aria-label={`移除 ${image.name}`}
            >
              <PixelIcon name="close" className="image-attachment__remove-icon" />
            </button>
          )}
        </figure>
      ))}
    </div>
  );
}
