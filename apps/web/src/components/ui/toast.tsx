"use client";

import { useEffect, useSyncExternalStore } from "react";
import { Check, Info, TriangleAlert, Undo2, X } from "lucide-react";
import { useShortcut } from "../../lib/keyboard";
import { errorMessage } from "../../lib/snapshot";
import { undoAction, usePendingActions } from "../../lib/undo";
import { Button, IconButton } from "./button";
import { cx } from "./cx";

/**
 * Toasts (DESIGN §3.5): bottom-centre, one at a time (FIFO), never steal
 * focus, never repeat text already shown in a page status region.
 * Info/success are polite and leave after 4 s; errors are alerts that stay
 * until dismissed. Undo windows from lib/undo show first, as an UndoToast.
 */
export type ToastTone = "info" | "success" | "error";
export interface ToastOptions { tone?: ToastTone; action?: { label: string; onClick: () => void } }
interface ToastItem extends Required<Pick<ToastOptions, "tone">> { id: number; message: string; action?: ToastOptions["action"] }

let queue: ToastItem[] = [];
let nextId = 0;
const listeners = new Set<() => void>();
const publish = () => listeners.forEach((listener) => listener());

/** Shows a toast; returns its id (for dismissToast). */
export function toast(message: string, options: ToastOptions = {}): number {
  const item: ToastItem = { id: ++nextId, message, tone: options.tone ?? "info", action: options.action };
  queue = [...queue, item];
  publish();
  return item.id;
}
export function dismissToast(id: number) {
  queue = queue.filter((item) => item.id !== id);
  publish();
}

/**
 * Runs a store action and reports the outcome: the `success` toast when
 * given, else nothing; on failure the error's own message (store errors are
 * written to be shown) or `fallback`. Resolves true when the action succeeded.
 */
export async function toastAction(run: () => Promise<unknown>, { success, fallback }: { success?: string; fallback: string }): Promise<boolean> {
  try {
    await run();
    if (success) toast(success, { tone: "success" });
    return true;
  } catch (error) {
    toast(errorMessage(error, fallback), { tone: "error" });
    return false;
  }
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const EMPTY: ToastItem[] = [];

const POSITION = "pointer-events-none fixed inset-x-0 z-[60] flex justify-center px-4 bottom-[calc(var(--dd-tabbar-h)+env(safe-area-inset-bottom)+16px)] md:bottom-6";
const CARD = "pointer-events-auto relative flex w-full max-w-[420px] items-center gap-3 overflow-hidden rounded-md border border-hairline bg-surface-raised px-4 py-3 text-body text-ink shadow-raised";

/** Mount once (the shell does). */
export function Toaster() {
  const items = useSyncExternalStore(subscribe, () => queue, () => EMPTY);
  const pending = usePendingActions();
  const undo = [...pending].reverse().find((action) => action.toast);
  const head = undo ? null : items[0];

  useEffect(() => {
    if (!head || head.tone === "error") return;
    const timer = setTimeout(() => dismissToast(head.id), 4_000);
    return () => clearTimeout(timer);
  }, [head]);

  // `z` and ⌘Z / Ctrl+Z undo while an undo window is showing (outside text fields).
  useShortcut(["z", "mod+z"], () => { if (undo) undoAction(undo.id); }, { enabled: Boolean(undo) });

  const Icon = head?.tone === "error" ? TriangleAlert : head?.tone === "success" ? Check : Info;
  return (
    <>
      {/* Persistent live regions so additions are announced; the cards themselves live inside them. */}
      <div role="status" className={POSITION}>
        {undo && (
          <div key={undo.id} className={CARD}>
            <Undo2 aria-hidden size={16} className="shrink-0 text-ink-2" />
            <p className="min-w-0 flex-1">
              {undo.message}
              <span className="sr-only"> Undo available for {undo.seconds} seconds.</span>
            </p>
            <Button size="sm" variant="ghost" className="text-ink" kbd="z" aria-keyshortcuts="Z Meta+Z Control+Z" onClick={() => undoAction(undo.id)}>Undo</Button>
            <span aria-hidden className="dd-drain absolute inset-x-0 bottom-0 h-0.5 bg-ink" style={{ ["--dd-drain" as string]: `${undo.seconds}s` }} />
          </div>
        )}
        {head && head.tone !== "error" && (
          <div key={head.id} className={CARD}>
            <Icon aria-hidden size={16} className={cx("shrink-0", head.tone === "success" ? "text-success" : "text-ink-2")} />
            <p className="min-w-0 flex-1">{head.message}</p>
            {head.action && <Button size="sm" variant="ghost" className="text-ink" onClick={() => { dismissToast(head.id); head.action!.onClick(); }}>{head.action.label}</Button>}
          </div>
        )}
      </div>
      <div role="alert" className={POSITION}>
        {head && head.tone === "error" && (
          <div key={head.id} className={cx(CARD, "border-danger")}>
            <Icon aria-hidden size={16} className="shrink-0 text-danger" />
            <p className="min-w-0 flex-1">{head.message}</p>
            {head.action && <Button size="sm" variant="ghost" className="text-ink" onClick={() => { dismissToast(head.id); head.action!.onClick(); }}>{head.action.label}</Button>}
            <IconButton size="sm" label="Dismiss" icon={X} onClick={() => dismissToast(head.id)} />
          </div>
        )}
      </div>
    </>
  );
}
