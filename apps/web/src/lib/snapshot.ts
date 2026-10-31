import type { AppSnapshot, LoadState, Slice } from "./types";

export const IDLE: Slice<never> = Object.freeze({ status: "idle", data: null, error: null, errorStatus: null, loadedAt: null, stale: false }) as Slice<never>;

export function ready<T>(data: T): Slice<T> {
  return { status: "ready", data, error: null, errorStatus: null, loadedAt: Date.now(), stale: false };
}
export function loading<T>(previous: Slice<T>): Slice<T> {
  return { ...previous, status: "loading", error: null, errorStatus: null };
}
export function failed<T>(previous: Slice<T>, error: string, errorStatus: number | null): Slice<T> {
  return { ...previous, status: "error", error, errorStatus };
}

/** How long a loaded slice counts as fresh: a screen mounting within this skips the reload. */
export const SLICE_FRESH_MS = 30_000;

/** Ready, untouched by a write since it loaded, and loaded within SLICE_FRESH_MS of `now`. */
export function isFresh(slice: Slice<unknown>, now: number): boolean {
  return slice.status === "ready" && !slice.stale && slice.loadedAt !== null && now - slice.loadedAt < SLICE_FRESH_MS;
}

/** A fresh, data-free snapshot: what every account switch resets to (tenant isolation). */
export function emptySnapshot(state: LoadState, epoch = 0): AppSnapshot {
  return {
    threads: [],
    ledger: [],
    money: { currency: "INR", locale: "en-IN" },
    timezone: "Asia/Kolkata",
    workspaceName: null,
    dashboard: null,
    onboarded: false,
    state,
    error: null,
    epoch,
    loadedAt: null,
    details: {},
    closed: IDLE,
    ledgerView: IDLE,
    insights: IDLE,
    offers: IDLE,
    voice: IDLE,
    audit: IDLE,
    settings: IDLE,
    me: IDLE,
    notificationPrefs: IDLE,
    billing: IDLE,
    seats: IDLE,
    roster: IDLE,
    onboarding: IDLE,
    ignoreList: IDLE,
    dataSummary: IDLE,
  };
}

/** The error's message when it has one worth showing (store errors are written to be shown), else `fallback`. */
export function errorMessage(error: unknown, fallback = "DealDock could not load this account."): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}
export function errorStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}
