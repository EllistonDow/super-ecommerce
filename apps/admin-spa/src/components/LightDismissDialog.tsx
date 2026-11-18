import { useEffect, useId, useRef, type ReactNode } from "react";

export interface LightDismissDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

/**
 * Accessible Top-Layer Modal `<dialog>` (`light-dismiss-a-dialog` compliant):
 * - Declarative `closedby="any"` for native backdrop & Esc light-dismiss
 * - Always opened via `dialog.showModal()`
 * - Includes mandatory `!('closedBy' in HTMLDialogElement.prototype)` bounding-rect
 *   backdrop click fallback for Safari / engines without `closedby`
 */
export function LightDismissDialog({
  open,
  title,
  onClose,
  children,
}: LightDismissDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open && typeof dialog.showModal === "function") {
      dialog.showModal();
    } else if (!open && dialog.open && typeof dialog.close === "function") {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || typeof HTMLDialogElement === "undefined") return;

    const handleClose = () => onClose();
    dialog.addEventListener("close", handleClose);

    let removeFallbackClick: (() => void) | undefined;
    if (!("closedBy" in HTMLDialogElement.prototype)) {
      const handleBackdropClick = (event: MouseEvent) => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        const isDialogContent =
          rect.top <= event.clientY &&
          event.clientY <= rect.top + rect.height &&
          rect.left <= event.clientX &&
          event.clientX <= rect.left + rect.width;
        if (isDialogContent) return;
        dialog.close();
      };
      dialog.addEventListener("click", handleBackdropClick);
      removeFallbackClick = () => dialog.removeEventListener("click", handleBackdropClick);
    }

    return () => {
      dialog.removeEventListener("close", handleClose);
      removeFallbackClick?.();
    };
  }, [onClose]);

  return (
    <dialog
      ref={dialogRef}
      className="oms-dialog"
      aria-labelledby={titleId}
      {...({ closedby: "any" } as Record<string, string>)}
    >
      <div className="dialog-header">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="btn" onClick={() => dialogRef.current?.close()}>
          Close
        </button>
      </div>
      {children}
    </dialog>
  );
}
