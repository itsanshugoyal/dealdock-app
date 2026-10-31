"use client";

import { useSyncExternalStore } from "react";
import { getUiPrefs } from "./ui-prefs";

/**
 * Undo windows (DESIGN §3.5):
 * 1. Server-reversible actions (`reverse` given) commit at once; Undo sends the reverse call.
 * 2. Everything else waits for the window before calling the API (`commit`).
 *    In-app navigation flushes pending non-send actions immediately.
 * 3. Sends (`kind: "send"`) only fire while the app is open and online: going
 *    offline, unloading the page or switching account cancels them — never queued.
 * Any account switch cancels every pending action (`cancelPendingActions`).
 */

export type UndoOutcome =
  | { status: "committed" }
  | { status: "undone" }
  | { status: "failed"; error: unknown }
  | { status: "cancelled"; reason: CancelReason };
export type CancelReason = "offline" | "closed" | "account";

export interface PendingAction {
  /** What runUndoable returned; undoAction(id) undoes it. */
  id: string;
  message: string;
  /** Length of the window (the creator's undo setting unless the caller chose one). */
  seconds: number;
  /** Epoch ms the window opened; with `seconds`, enough to draw a countdown (secondsLeft). */
  startedAt: number;
  kind: "action" | "send";
  /** Show in the UndoToast (sends show their countdown in the composer instead). */
  toast: boolean;
}

export interface UndoableOptions {
  /** Past-tense sentence, shown and announced once: "Moved to waiting." */
  message: string;
  /** The API call. Runs now when `reverse` is given, otherwise after the window. */
  commit: () => Promise<unknown>;
  /** Server-side reversal; when present the action commits immediately. */
  reverse?: () => Promise<unknown>;
  /** Restore local UI after Undo or a cancellation. */
  onUndo?: () => void;
  kind?: "action" | "send";
  /** Defaults to the creator's undo window setting (5/10/20 s). */
  seconds?: number;
  toast?: boolean;
}

interface Entry {
  action: PendingAction;
  complete: () => Promise<void>;
  undo: () => Promise<void>;
  cancel: (reason: CancelReason) => void;
}

const pending = new Map<string, Entry>();
const listeners = new Set<() => void>();
let published: PendingAction[] = [];
let sequence = 0;
let wired = false;

function publish() {
  published = [...pending.values()].map((entry) => entry.action);
  listeners.forEach((listener) => listener());
}

function wireBrowserEvents() {
  if (wired || typeof window === "undefined") return;
  wired = true;
  window.addEventListener("offline", () => cancelPendingActions("offline", "send"));
  window.addEventListener("pagehide", () => {
    cancelPendingActions("closed", "send");
    flushPendingActions();
  });
}

export function runUndoable(options: UndoableOptions) {
  wireBrowserEvents();
  const id = `undo-${++sequence}`;
  const kind = options.kind ?? "action";
  const seconds = options.seconds ?? getUiPrefs().undoSeconds;
  let settle!: (outcome: UndoOutcome) => void;
  const outcome = new Promise<UndoOutcome>((resolve) => { settle = resolve; });
  const early = options.reverse ? options.commit() : null;
  // A failed early commit ends the window at once; nothing remains to undo.
  early?.catch((error: unknown) => { if (pending.delete(id)) { clearTimeout(timer); publish(); } settle({ status: "failed", error }); });

  const finish = () => {
    clearTimeout(timer);
    const had = pending.delete(id);
    if (had) publish();
    return had;
  };
  const complete = async () => {
    if (!finish()) return;
    if (early) { try { await early; settle({ status: "committed" }); } catch (error) { settle({ status: "failed", error }); } return; }
    try { await options.commit(); settle({ status: "committed" }); } catch (error) { settle({ status: "failed", error }); }
  };
  const undo = async () => {
    if (!finish()) return;
    options.onUndo?.();
    if (early && options.reverse) {
      try { await early; await options.reverse(); } catch (error) { settle({ status: "failed", error }); return; }
    }
    settle({ status: "undone" });
  };
  const cancel = (reason: CancelReason) => {
    if (!finish()) return;
    options.onUndo?.();
    settle({ status: "cancelled", reason });
  };
  const timer = setTimeout(() => void complete(), seconds * 1000);
  pending.set(id, { action: { id, message: options.message, seconds, startedAt: Date.now(), kind, toast: options.toast ?? kind === "action" }, complete, undo, cancel });
  publish();
  if (kind === "send" && typeof navigator !== "undefined" && !navigator.onLine) cancel("offline");
  return { id, outcome, undo, flush: complete, cancel: () => cancel("closed") };
}

export function undoAction(id: string) { void pending.get(id)?.undo(); }

/** In-app navigation: pending non-send actions commit now. */
export function flushPendingActions() {
  for (const entry of [...pending.values()]) if (entry.action.kind !== "send") void entry.complete();
}
export function cancelPendingActions(reason: CancelReason, kind?: PendingAction["kind"]) {
  for (const entry of [...pending.values()]) if (!kind || entry.action.kind === kind) entry.cancel(reason);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const EMPTY: PendingAction[] = [];
export function usePendingActions(): PendingAction[] {
  return useSyncExternalStore(subscribe, () => published, () => EMPTY);
}
/** One pending action by the id runUndoable returned; null once it committed, was undone or cancelled. */
export function usePendingAction(id: string | null | undefined): PendingAction | null {
  const pendingActions = usePendingActions();
  return id ? pendingActions.find((action) => action.id === id) ?? null : null;
}
/** Whole seconds left in an action's window at `now` ("Sending in 3s"). */
export function secondsLeft(action: Pick<PendingAction, "seconds" | "startedAt">, now: number): number {
  return Math.max(0, action.seconds - Math.floor((now - action.startedAt) / 1000));
}
