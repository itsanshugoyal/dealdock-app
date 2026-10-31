"use client";

import { useCallback, useId, useLayoutEffect, useRef, useState, type SyntheticEvent } from "react";

type Align = "start" | "end" | "center";

/** Places a top-layer popover next to its trigger, flipping above when there is no room below. */
export function anchorPopover(popover: HTMLElement, trigger: HTMLElement, align: Align = "start") {
  const anchor = trigger.getBoundingClientRect();
  const box = popover.getBoundingClientRect();
  const gap = 4;
  const edge = 8;
  let left = align === "end" ? anchor.right - box.width : align === "center" ? anchor.left + anchor.width / 2 - box.width / 2 : anchor.left;
  left = Math.max(edge, Math.min(left, window.innerWidth - box.width - edge));
  let top = anchor.bottom + gap;
  if (top + box.height > window.innerHeight - edge && anchor.top - gap - box.height >= edge) top = anchor.top - gap - box.height;
  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
}

/**
 * Native popover (Popover API, light dismiss, Escape) anchored to a trigger
 * button. Spread `triggerProps` on a <button> and `popoverProps` on the panel.
 */
export function usePopover(align: Align = "start") {
  const id = useId();
  const trigger = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const onToggle = useCallback((event: SyntheticEvent) => {
    const isOpen = (event.nativeEvent as ToggleEvent).newState === "open";
    setOpen(isOpen);
    if (isOpen && panel.current && trigger.current) anchorPopover(panel.current, trigger.current, align);
  }, [align]);
  // Re-anchor once the content has rendered (it mounts only while open).
  useLayoutEffect(() => {
    if (open && panel.current && trigger.current) anchorPopover(panel.current, trigger.current, align);
  }, [open, align]);
  return {
    open,
    close: () => panel.current?.hidePopover(),
    triggerProps: {
      ref: (element: HTMLElement | null) => { trigger.current = element; },
      popoverTarget: id,
      "aria-expanded": open,
    },
    popoverProps: {
      ref: (element: HTMLElement | null) => { panel.current = element; },
      id,
      popover: "auto" as const,
      onToggle,
    },
  };
}
