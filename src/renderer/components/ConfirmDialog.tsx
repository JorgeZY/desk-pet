import { useId, useLayoutEffect, useRef } from "react";
import { PixelIcon } from "./PixelIcon";

interface ConfirmDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  pendingLabel: string;
  pending: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  pendingLabel,
  pending,
  error,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    if (pending) {
      dialogRef.current?.focus({ preventScroll: true });
    } else {
      cancelRef.current?.focus({ preventScroll: true });
    }
  }, [pending]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!pending) onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    event.preventDefault();

    if (pending) {
      dialogRef.current?.focus({ preventScroll: true });
      return;
    }

    const focusable = [cancelRef.current, confirmRef.current].filter(
      (button): button is HTMLButtonElement => Boolean(button && !button.disabled),
    );
    if (!focusable.length) return;
    const currentIndex = focusable.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.shiftKey
      ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
      : (currentIndex + 1) % focusable.length;
    focusable[nextIndex]?.focus({ preventScroll: true });
  };

  return (
    <div
      className="confirm-dialog-backdrop"
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onCancel();
      }}
    >
      <section
        ref={dialogRef}
        className="confirm-dialog confirm-dialog--danger"
        role="alertdialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={pending}
      >
        <div className="confirm-dialog__heading">
          <span className="confirm-dialog__icon" aria-hidden="true">
            <PixelIcon name="trash" />
          </span>
          <div>
            <h2 id={titleId}>{title}</h2>
            <p id={descriptionId}>{description}</p>
          </div>
        </div>
        {error && <p className="confirm-dialog__error" role="alert">{error}</p>}
        <div className="confirm-dialog__actions">
          <button
            ref={cancelRef}
            className="button button--quiet"
            type="button"
            disabled={pending}
            onClick={onCancel}
          >
            取消
          </button>
          <button
            ref={confirmRef}
            className="button button--danger"
            type="button"
            disabled={pending}
            onClick={onConfirm}
          >
            <PixelIcon name="trash" />
            {pending ? pendingLabel : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
