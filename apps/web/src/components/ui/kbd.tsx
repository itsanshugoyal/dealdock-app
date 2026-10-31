"use client";

import { useSyncExternalStore } from "react";
import { isApplePlatform } from "../../lib/keyboard";
import { cx } from "./cx";

const noopSubscribe = () => () => {};
export function useIsApple(): boolean {
  return useSyncExternalStore(noopSubscribe, isApplePlatform, () => false);
}

const NAMES: Record<string, string> = { enter: "↵", shift: "⇧", escape: "Esc", esc: "Esc", alt: "Alt", up: "↑", down: "↓" };

/** "mod+k" → ["⌘", "K"] on Apple, ["Ctrl", "K"] elsewhere; "g t" → ["G", "T"]. */
export function shortcutParts(keys: string, apple: boolean): string[] {
  return keys.split(/[+ ]/).filter(Boolean).map((part) => {
    const key = part.toLowerCase();
    if (key === "mod") return apple ? "⌘" : "Ctrl";
    return NAMES[key] ?? (part.length === 1 ? part.toUpperCase() : part);
  });
}

/**
 * Key caps (DESIGN §3.1). Hidden on touch screens. Inside a button it is
 * decorative — the button carries `aria-keyshortcuts` instead.
 */
export function Kbd({ keys, className, decorative = true }: { keys: string; className?: string; decorative?: boolean }) {
  const apple = useIsApple();
  return (
    <span aria-hidden={decorative || undefined} className={cx("dd-kbd inline-flex items-center gap-0.5", className)}>
      {shortcutParts(keys, apple).map((part, index) => (
        <kbd key={index} className="inline-flex h-4 min-w-[18px] items-center justify-center rounded-sm border border-hairline bg-inset px-1 text-kbd text-ink-2">
          {part}
        </kbd>
      ))}
    </span>
  );
}
