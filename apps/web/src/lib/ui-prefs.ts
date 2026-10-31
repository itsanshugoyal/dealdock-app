"use client";

import { useSyncExternalStore } from "react";
import { THEME_STORAGE_KEY } from "./theme-script";

/**
 * UI preferences (never data): theme, undo window and single-key shortcuts.
 * Stored in localStorage like the theme (DESIGN §2.1, §5.10); every access is
 * wrapped because storage can be unavailable.
 */
export type ThemePreference = "system" | "light" | "dark";
export type UndoSeconds = 5 | 10 | 20;
export interface UiPrefs {
  theme: ThemePreference;
  undoSeconds: UndoSeconds;
  singleKeyShortcuts: boolean;
}

const DEFAULTS: UiPrefs = { theme: "system", undoSeconds: 5, singleKeyShortcuts: true };
const KEYS: Record<keyof UiPrefs, string> = {
  theme: THEME_STORAGE_KEY,
  undoSeconds: "dealdock.undoSeconds",
  singleKeyShortcuts: "dealdock.singleKeyShortcuts",
};
const listeners = new Set<() => void>();
let current: UiPrefs | null = null;

function stored(key: keyof UiPrefs): string | null {
  try { return localStorage.getItem(KEYS[key]); } catch { return null; }
}
function read(): UiPrefs {
  const theme = stored("theme");
  const undo = Number(stored("undoSeconds"));
  return {
    theme: theme === "light" || theme === "dark" ? theme : "system",
    undoSeconds: undo === 10 || undo === 20 ? undo : 5,
    singleKeyShortcuts: stored("singleKeyShortcuts") !== "false",
  };
}

export function getUiPrefs(): UiPrefs {
  if (typeof window === "undefined") return DEFAULTS;
  current ??= read();
  return current;
}

export function setUiPref<K extends keyof UiPrefs>(key: K, value: UiPrefs[K]) {
  current = { ...getUiPrefs(), [key]: value };
  try { localStorage.setItem(KEYS[key], String(value)); } catch { /* preference lasts for this page only */ }
  if (key === "theme") applyTheme(value as ThemePreference);
  listeners.forEach((listener) => listener());
}

/** Stamps data-theme now; the boot script's listener keeps "system" in sync with the OS. */
export function applyTheme(preference: ThemePreference) {
  const dark = preference === "dark" || (preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function useUiPrefs(): UiPrefs {
  return useSyncExternalStore(subscribe, getUiPrefs, () => DEFAULTS);
}
