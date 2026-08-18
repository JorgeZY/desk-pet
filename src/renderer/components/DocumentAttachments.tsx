import type { ChatDocument } from "../../shared/types";
import { PixelIcon } from "./PixelIcon";

interface DocumentAttachButtonProps {
  documents: ChatDocument[];
  disabled?: boolean;
  onChange: (documents: ChatDocument[]) => void;
  onError: (message: string) => void;
}

export function DocumentAttachButton({
  documents,
  disabled = false,
  onChange,
  onError,
}: DocumentAttachButtonProps) {
  const pick = async () => {
    onError("");
    try {
      const selected = await window.desktopPet.pickChatDocuments();
      if (selected.length) onChange(selected);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <button
      className="document-attach-button"
      type="button"
      onClick={() => void pick()}
      disabled={disabled}
      aria-label={documents.length ? `重新上传文档，当前 ${documents.length} 个` : "上传文本或 PDF 文档"}
      title="上传文本或 PDF（最多 5 个，PDF 按文字读取）"
    >
      <PixelIcon name="document" />
      {documents.length > 0 ? <b>{documents.length}</b> : null}
    </button>
  );
}

interface DocumentAttachmentTrayProps {
  documents: ChatDocument[];
  onRemove?: (index: number) => void;
}

export function DocumentAttachmentTray({ documents, onRemove }: DocumentAttachmentTrayProps) {
  if (!documents.length) return null;
  return (
    <div className="document-attachment-tray">
      {documents.map((document, index) => (
        <article
          className="document-attachment"
          key={`${document.path}-${index}`}
          title={`${document.name} · ${document.characterCount.toLocaleString("zh-CN")} 字符`}
        >
          <PixelIcon name="document" />
          <span>
            <b>{document.name}</b>
            <small>
              {document.mimeType === "application/pdf" ? "PDF" : "文本"}
              {document.truncated ? " · 已截断" : ""}
            </small>
          </span>
          {onRemove ? (
            <button
              type="button"
              onClick={() => onRemove(index)}
              aria-label={`移除 ${document.name}`}
            >
              <PixelIcon name="close" />
            </button>
          ) : null}
        </article>
      ))}
    </div>
  );
}
