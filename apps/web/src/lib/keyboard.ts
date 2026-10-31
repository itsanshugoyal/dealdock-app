"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { getUiPrefs } from "./ui-prefs";

/**
 * Keyboard layer (DESIGN §4.4). Single-character shortcuts only fire outside
 * text fields and can be switched off in Settings (WCAG 2.1.4); modifier
 * shortcuts ("mod+k", "mod+enter") always work. "mod" is ⌘ on Apple, Ctrl elsewhere.
 */

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (target as HTMLInputElement).type;
  return !["button", "checkbox", "radio", "range", "submit", "reset", "color", "file"].includes(type);
}

export function isApplePlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

/** Matches "j", "?", "shift+?", "mod+k", "mod+enter", "escape" against a keydown event. */
export function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const parts = shortcut.toLowerCase().split("+");
  const key = parts.pop()!;
  const mod = parts.includes("mod");
  const shift = parts.includes("shift");
  const alt = parts.includes("alt");
  const hasMod = event.metaKey || event.ctrlKey;
  if (mod !== hasMod || alt !== event.altKey) return false;
  if (shift && !event.shiftKey) return false;
  const pressed = event.key.toLowerCase();
  return pressed === key || (key === "enter" && pressed === "enter") || (key === "esc" && pressed === "escape");
}

/** True for shortcuts that need a modifier (always on, even inside text fields if allowed). */
function hasModifier(shortcut: string) {
  return /(^|\+)(mod|alt)\+/.test(shortcut.toLowerCase());
}

export interface ShortcutOptions {
  enabled?: boolean;
  /** Let a modifier shortcut fire while typing (e.g. ⌘↵ in the composer). */
  allowInInputs?: boolean;
  preventDefault?: boolean;
}

/**
 * Registers a keydown shortcut for the lifetime of the component.
 * Screens use this for their local keys (j/k, w, x, c, y, n, 1–8 …).
 */
export function useShortcut(shortcuts: string | string[], handler: (event: KeyboardEvent) => void, options: ShortcutOptions = {}) {
  const ref = useRef(handler);
  ref.current = handler;
  const list = Array.isArray(shortcuts) ? shortcuts : [shortcuts];
  const key = list.join("|");
  const { enabled = true, allowInInputs = false, preventDefault = true } = options;
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const match = key.split("|").find((shortcut) => matchesShortcut(event, shortcut));
      if (!match) return;
      const modifier = hasModifier(match);
      if (!modifier && !getUiPrefs().singleKeyShortcuts) return;
      if (isTypingTarget(event.target) && !(modifier && allowInInputs) && match !== "escape") return;
      // An open sheet or dialog owns the keyboard; single keys stay quiet while it shows.
      if (!modifier && document.querySelector("dialog[open]")) return;
      if (preventDefault) event.preventDefault();
      ref.current(event);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [key, enabled, allowInInputs, preventDefault]);
}

// ── Shared clocks and connectivity ────────────────────────────────────────

let now = 0;
let ticker: ReturnType<typeof setInterval> | null = null;
const clockListeners = new Set<() => void>();
function subscribeClock(listener: () => void) {
  clockListeners.add(listener);
  if (!ticker) {
    now = Date.now();
    ticker = setInterval(() => { now = Date.now(); clockListeners.forEach((fn) => fn()); }, 60_000);
  }
  return () => {
    clockListeners.delete(listener);
    if (!clockListeners.size && ticker) { clearInterval(ticker); ticker = null; }
  };
}
/** Minute-resolution "now" shared by every clock on screen. 0 during SSR — render nothing time-relative then. */
export function useMinuteClock(): number {
  return useSyncExternalStore(subscribeClock, () => now || (now = Date.now()), () => 0);
}

function subscribeOnline(listener: () => void) {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => { window.removeEventListener("online", listener); window.removeEventListener("offline", listener); };
}
export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
}

const mediaSubscribers = new Map<string, (listener: () => void) => () => void>();
function subscribeMedia(query: string) {
  let subscribe = mediaSubscribers.get(query);
  if (!subscribe) {
    subscribe = (listener: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", listener);
      return () => media.removeEventListener("change", listener);
    };
    mediaSubscribers.set(query, subscribe);
  }
  return subscribe;
}
/** Live media-query match (false during SSR). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(subscribeMedia(query), () => window.matchMedia(query).matches, () => false);
}
export const useReducedMotion = () => useMediaQuery("(prefers-reduced-motion: reduce)");
