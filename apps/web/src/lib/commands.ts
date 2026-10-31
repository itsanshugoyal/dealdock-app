"use client";

import { useEffect, useRef } from "react";

/**
 * Global command bus: the palette and shortcut layer dispatch, screens listen.
 * Example: a thread page handles "record-sale" by opening its sale sheet.
 */
export type AppCommand =
  | "open-palette"
  | "open-shortcuts"
  | "record-sale"
  | "toggle-waiting"
  | "regenerate-draft";

export interface CommandDetail { command: AppCommand; threadId?: string }
const EVENT = "dealdock:command";

export function dispatchCommand(command: AppCommand, threadId?: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<CommandDetail>(EVENT, { detail: { command, threadId } }));
}

/** Subscribe a screen to a command for as long as it is mounted. */
export function useCommand(command: AppCommand, handler: (detail: CommandDetail) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<CommandDetail>).detail;
      if (detail?.command === command) ref.current(detail);
    };
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
  }, [command]);
}
