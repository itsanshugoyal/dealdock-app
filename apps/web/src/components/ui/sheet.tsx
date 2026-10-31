"use client";

import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";
import { Button, IconButton } from "./button";
import { cx } from "./cx";

export interface SheetProps {
  open: boolean;
  /** Called for Escape, backdrop, the Close button or a swipe down — the parent sets `open=false`. */
  onClose: () => void;
  /** Visible h2, and the dialog's accessible name: the name always matches what people see (WCAG 2.5.3). */
  title: ReactNode;
  description?: ReactNode;
  /** Desktop placement: "side" (440 px reference panel) or "center" (480 px form). Phones always get a bottom sheet. */
  placement?: "side" | "center" | "dialog";
  /** Sticky footer actions (safe-area padded). */
  footer?: ReactNode;
  /** When true, closing asks "Discard changes?" inside the sheet instead of closing. */
  dirty?: boolean;
  /** "first" focuses the first field (forms); "title" the heading (reference); or a specific element. */
  initialFocus?: "first" | "title" | RefObject<HTMLElement | null>;
  className?: string;
  children?: ReactNode;
}

const FIELD = "input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])";

/**
 * Native <dialog> + showModal(): focus trap, Escape, top layer, inert page,
 * scroll lock (CSS) and focus return to the trigger. Content mounts only while
 * open so its controls never collide with page locators.
 */
export function Sheet({ open, onClose, title, description, placement = "center", footer, dirty = false, initialFocus = "first", className, children }: SheetProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const returnTo = useRef<Element | null>(null);
  const pressedOnBackdrop = useRef(false);
  const drag = useRef<{ y: number; at: number } | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [mounted, setMounted] = useState(open);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) {
      returnTo.current = document.activeElement;
      setMounted(true);
      setConfirming(false);
      node.showModal();
    } else if (!open && node.open) {
      node.close();
    }
  }, [open]);

  // Initial focus once the content has mounted.
  useEffect(() => {
    if (!open || !mounted) return;
    const node = dialog.current;
    const target = typeof initialFocus === "object" ? initialFocus.current : initialFocus === "title" ? titleRef.current : node?.querySelector<HTMLElement>(`[data-sheet-body] :is(${FIELD})`) ?? titleRef.current;
    target?.focus();
    // initialFocus is read once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mounted]);

  const requestClose = () => {
    if (dirty && !confirming) { setConfirming(true); return; }
    onClose();
  };

  return (
    <dialog
      ref={dialog}
      data-placement={placement}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      className={cx("dd-sheet", className)}
      onCancel={(event) => { event.preventDefault(); requestClose(); }}
      onClose={() => {
        const target = returnTo.current;
        if (target instanceof HTMLElement && target.isConnected) target.focus();
        // Keep content through the exit transition, then unmount.
        setTimeout(() => { if (!dialog.current?.open) setMounted(false); }, 300);
      }}
      onPointerDown={(event) => { pressedOnBackdrop.current = event.target === dialog.current; }}
      onClick={(event) => { if (pressedOnBackdrop.current && event.target === dialog.current) requestClose(); }}
    >
      {mounted && (
        <>
          <div
            aria-hidden
            className="flex h-6 shrink-0 cursor-grab touch-none items-center justify-center md:hidden"
            onPointerDown={(event) => { drag.current = { y: event.clientY, at: event.timeStamp }; event.currentTarget.setPointerCapture(event.pointerId); }}
            onPointerMove={(event) => {
              if (!drag.current || !dialog.current) return;
              dialog.current.style.transform = `translateY(${Math.max(0, event.clientY - drag.current.y)}px)`;
            }}
            onPointerUp={(event) => {
              const start = drag.current;
              drag.current = null;
              if (dialog.current) dialog.current.style.transform = "";
              if (!start) return;
              const distance = event.clientY - start.y;
              const fast = distance > 40 && distance / Math.max(1, event.timeStamp - start.at) > 0.6;
              if (distance > 96 || fast) requestClose();
            }}
          >
            <span className="h-1 w-9 rounded-full bg-hairline" />
          </div>
          <div className="flex shrink-0 items-start gap-3 px-4 pb-2 md:px-5 md:pt-5">
            <div className="min-w-0 flex-1 pt-2">
              <h2 id={titleId} ref={titleRef} tabIndex={-1} className="text-heading text-ink outline-none">{title}</h2>
              {description && <div id={descriptionId} className="mt-1 text-body text-ink-2">{description}</div>}
            </div>
            <IconButton label="Close" icon={X} onClick={requestClose} />
          </div>
          {confirming && (
            <div role="alert" className="mx-4 mb-2 flex flex-wrap items-center gap-2 rounded-md bg-inset p-3 md:mx-5">
              <p className="flex-1 text-body text-ink">Discard changes?</p>
              <Button size="sm" variant="secondary" autoFocus onClick={() => setConfirming(false)}>Keep editing</Button>
              <Button size="sm" variant="danger-ghost" onClick={onClose}>Discard</Button>
            </div>
          )}
          <div data-sheet-body className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 md:px-5">{children}</div>
          {footer && (
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-hairline px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] md:px-5">
              {footer}
            </div>
          )}
        </>
      )}
    </dialog>
  );
}

/**
 * ConfirmDialog (DESIGN §3.2) — replaces every window.confirm. Title states the
 * action; Cancel gets initial focus; the verb is danger for destructive actions.
 */
export function ConfirmDialog({ open, onClose, title, children, confirmLabel, onConfirm, destructive = false, busy = false, busyLabel, cancelLabel = "Cancel", error }: {
  open: boolean;
  onClose: () => void;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  destructive?: boolean;
  busy?: boolean;
  busyLabel?: string;
  cancelLabel?: string;
  error?: string | null;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      placement="dialog"
      initialFocus={cancel}
      footer={
        <>
          <Button ref={cancel} variant="ghost" onClick={onClose} disabled={busy}>{cancelLabel}</Button>
          <Button variant={destructive ? "danger" : "primary"} onClick={onConfirm} loading={busy} loadingLabel={busyLabel}>{confirmLabel}</Button>
        </>
      }
    >
      {children && <div className="text-body text-ink-2">{children}</div>}
      {error && <p role="alert" className="mt-3 text-caption text-danger">{error}</p>}
    </Sheet>
  );
}
