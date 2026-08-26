import type { ChatDocument } from "../../shared/types";
import { Button } from "@/components/ui/button";
import {
  PromptInputActionMenuItem,
  PromptInputButton,
} from "./ai-elements/prompt-input";
import { PixelIcon } from "./PixelIcon";

interface DocumentAttachButtonProps {
  documents: ChatDocument[];
  disabled?: boolean;
  disabledReason?: string;
  menuItem?: boolean;
  onChange: (documents: ChatDocument[]) => void;
  onError: (message: string) => void;
}

export function DocumentAttachButton({
  documents,
  disabled = false,
  disabledReason,
  menuItem = false,
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

  const label = documents.length ? `重新上传文档，当前 ${documents.length} 个` : "上传文本或 PDF 文档";
  const tooltip = disabled
    ? disabledReason ?? "当前无法上传文档"
    : "上传文本或 PDF（最多 5 个，PDF 按文字读取）";
  const content = (
    <>
      <PixelIcon name="document" />
      {documents.length > 0 ? <b>{documents.length}</b> : null}
      {menuItem ? <span>上传文本或 PDF</span> : null}
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

interface DocumentAttachmentTrayProps {
  documents: ChatDocument[];
  onRemove?: (index: number) => void;
}

export function DocumentAttachmentTray({ documents, onRemove }: DocumentAttachmentTrayProps) {
  if (!documents.length) return null;
  return (
    <div className="flex flex-wrap gap-2" aria-label="已选择的文档">
      {documents.map((document, index) => (
        <article
          className="flex min-w-0 max-w-64 items-center gap-2 rounded-lg border bg-muted/40 px-2 py-1.5 text-xs"
          key={`${document.path}-${index}`}
          title={`${document.name} · ${document.characterCount.toLocaleString("zh-CN")} 字符`}
        >
          <PixelIcon name="document" />
          <span className="grid min-w-0 flex-1">
            <b className="truncate font-medium">{document.name}</b>
            <small className="text-muted-foreground">
              {document.mimeType === "application/pdf" ? "PDF" : "文本"}
              {document.truncated ? " · 已截断" : ""}
            </small>
          </span>
          {onRemove ? (
            <Button
              type="button"
              onClick={() => onRemove(index)}
              aria-label={`移除 ${document.name}`}
              size="icon-xs"
              variant="ghost"
            >
              <PixelIcon name="close" />
            </Button>
          ) : null}
        </article>
      ))}
    </div>
  );
}
