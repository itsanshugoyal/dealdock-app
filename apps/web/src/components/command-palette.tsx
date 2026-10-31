"use client";

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { dispatchCommand, useCommand } from "../lib/commands";
import { useShortcut } from "../lib/keyboard";
import { cx } from "./ui/cx";
import { Kbd } from "./ui/kbd";

// cmdk loads only when the palette first opens (performance budget, DESIGN §10).
const PaletteContent = lazy(() => import("./palette-content"));

export function openCommandPalette() {
  dispatchCommand("open-palette");
}

/** The search entry point: an icon on phones (top bar), "Search or jump to…" + ⌘K in the desktop rail. */
export function SearchButton({ variant = "icon", className }: { variant?: "icon" | "rail" | "rail-compact"; className?: string }) {
  if (variant === "icon") {
    return (
      <button type="button" aria-label="Search or jump to" aria-keyshortcuts="Meta+K Control+K" onClick={openCommandPalette} className={cx("dd-hit inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-ink-2 hover:bg-inset hover:text-ink", className)}>
        <Search size={20} />
      </button>
    );
  }
  if (variant === "rail-compact") {
    return (
      <button type="button" aria-label="Search or jump to" aria-keyshortcuts="Meta+K Control+K" onClick={openCommandPalette} className={cx("dd-press flex h-10 w-full items-center justify-center rounded-xl text-ink-2 hover:bg-inset hover:text-ink", className)}>
        <Search size={19} />
      </button>
    );
  }
  return (
    <button type="button" aria-label="Search or jump to" aria-keyshortcuts="Meta+K Control+K" onClick={openCommandPalette} className={cx("dd-press flex h-10 w-full items-center gap-2.5 rounded-xl bg-inset px-3 text-[14px] text-ink-3 hover:bg-fill hover:text-ink-2", className)}>
      <Search size={17} className="shrink-0" />
      <span className="flex-1 truncate text-left">Search</span>
      <Kbd keys="mod+k" />
    </button>
  );
}

/**
 * ⌘K command palette (DESIGN §4.3): cmdk inside a native <dialog>, centred
 * 640 px on desktop, full-screen on phones. Contents mount only while open so
 * their names never collide with page controls in strict locators.
 */
export function CommandPalette() {
  const dialog = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<Element | null>(null);
  const [open, setOpen] = useState(false);

  useCommand("open-palette", () => setOpen(true));
  useShortcut("mod+k", () => setOpen((value) => !value), { allowInInputs: true });

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) {
      returnTo.current = document.activeElement;
      node.showModal();
    } else if (!open && node.open) {
      node.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialog}
      data-placement="palette"
      aria-label="Command palette"
      className="dd-sheet"
      onCancel={(event) => { event.preventDefault(); setOpen(false); }}
      onClose={() => {
        setOpen(false);
        const target = returnTo.current;
        if (target instanceof HTMLElement && target.isConnected) target.focus();
      }}
      onClick={(event) => { if (event.target === dialog.current) setOpen(false); }}
    >
      {open && (
        <Suspense fallback={<p role="status" className="p-4 text-body text-ink-2">Loading…</p>}>
          <PaletteContent onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </dialog>
  );
}
