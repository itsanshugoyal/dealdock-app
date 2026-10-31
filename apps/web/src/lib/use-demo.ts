"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { can, type MoneyContext, type PermissionAction } from "@dealdock/core";
import { demoStore } from "./demo-store";
import { apiStore } from "./api-store";
import { emptySnapshot, isFresh } from "./snapshot";
import type { AppSnapshot, AppStoreApi, DemoThread, Slice, SliceKey } from "./types";

/** Demo is an explicit, separately-labelled local mode — never an API fallback. */
export const IS_DEMO_MODE =
  process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_DEALDOCK_DEMO_MODE === "true";

/**
 * Every screen action goes through `appStore`: the demo store in demo builds,
 * the API store otherwise. Both implement AppStoreApi with identical
 * signatures, so screens never branch on IS_DEMO_MODE for data.
 */
export const appStore: AppStoreApi = IS_DEMO_MODE ? demoStore : apiStore;

const SERVER_SNAPSHOT: AppSnapshot = { ...emptySnapshot("idle"), onboarded: true };

/** The whole app snapshot (core data + lazy slices). Re-renders on every store change. */
export function useApp(): AppSnapshot {
  useEffect(() => {
    void appStore.init();
  }, []);
  return useSyncExternalStore(appStore.subscribe, appStore.getSnapshot, () => SERVER_SNAPSHOT);
}

/**
 * Caches a selection the way useSyncExternalStore needs it: the same snapshot
 * gives back the same value, and a new value `isEqual` to the last one gives
 * back the last one. `last` is what the component rendered before, so a
 * selector recreated on render still returns an unchanged value.
 */
export function memoizeSelection<T>(selector: (snapshot: AppSnapshot) => T, isEqual: (a: T, b: T) => boolean, last?: { value: T } | null): (snapshot: AppSnapshot) => T {
  let memo: { snapshot: AppSnapshot; value: T } | null = null;
  return (snapshot) => {
    if (memo && memo.snapshot === snapshot) return memo.value;
    const next = selector(snapshot);
    const previous = memo ?? last;
    const value = previous && isEqual(previous.value, next) ? previous.value : next;
    memo = { snapshot, value };
    return value;
  };
}

/**
 * One value from the snapshot: the component re-renders only when `selector`
 * returns something new by `isEqual` (Object.is by default). Use a stable
 * selector, or an `isEqual` that recognises an equal new object.
 */
export function useAppSelector<T>(selector: (snapshot: AppSnapshot) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  useEffect(() => {
    void appStore.init();
  }, []);
  const rendered = useRef<{ value: T } | null>(null);
  const [getSelection, getServerSelection] = useMemo(() => {
    const select = memoizeSelection(selector, isEqual, rendered.current);
    return [() => select(appStore.getSnapshot()), () => select(SERVER_SNAPSHOT)] as const;
  }, [selector, isEqual]);
  const value = useSyncExternalStore(appStore.subscribe, getSelection, getServerSelection);
  useEffect(() => {
    rendered.current = { value };
  }, [value]);
  return value;
}

export interface MoneyView {
  money: MoneyContext;
  /** Org time zone — format every date with it, never the browser's. */
  timezone: string;
  /** The org locale (money.locale, else en-IN as every screen defaults it). */
  locale: string;
}
const selectMoney = (snapshot: AppSnapshot): MoneyView => ({ money: snapshot.money, timezone: snapshot.timezone, locale: snapshot.money.locale ?? "en-IN" });
const sameMoney = (a: MoneyView, b: MoneyView) => a.money.currency === b.money.currency && a.money.locale === b.money.locale && a.timezone === b.timezone;

/** Money context, time zone and locale for leaf components: the object changes only when one of them does. */
export function useMoneyContext(): MoneyView {
  return useAppSelector(selectMoney, sameMoney);
}

/** The inputs each slice was last loaded with through useLazy, tagged with the account epoch. */
const lastLoad = new Map<SliceKey, string>();

/**
 * Loads a lazy slice when a screen mounts it, again whenever its inputs
 * change, after every account switch (epoch) and whenever a write marks it
 * stale. A mount skips the load while the slice is fresh (isFresh: ready,
 * not stale, loaded within 30 s) for the same inputs. Returns the slice;
 * check `status`.
 */
export function useLazy<K extends SliceKey>(key: K, load: () => Promise<unknown>, deps: unknown[] = [], enabled = true): AppSnapshot[K] {
  const snapshot = useApp();
  const slice = snapshot[key];
  const request = `${snapshot.epoch}|${JSON.stringify(deps)}`;
  useEffect(() => {
    if (!enabled) return;
    if (lastLoad.get(key) === request && isFresh(appStore.getSnapshot()[key] as Slice<unknown>, Date.now())) return;
    lastLoad.set(key, request);
    void load();
    // `load` is recreated every render; the inputs, the account epoch and a write's stale mark decide when to reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, request, enabled, slice.stale]);
  return slice;
}

export const useInsights = (months = 6) => useLazy("insights", () => appStore.loadInsights(months), [months]);
export const useOffers = () => useLazy("offers", () => appStore.loadOffers());
export const useVoice = (igAccountId?: string) => useLazy("voice", () => appStore.loadVoice(igAccountId), [igAccountId]);
export const useAudit = (limit = 100) => useLazy("audit", () => appStore.loadAudit(limit), [limit]);
export const useLedger = (month?: string) => useLazy("ledgerView", () => appStore.loadLedger(month), [month]);
/** Closed threads load on demand (e.g. the Inbox "Closed" group's first expand). */
export const useClosedThreads = (enabled = true) => useLazy("closed", () => appStore.loadClosed(), [], enabled);
export const useSettings = () => useLazy("settings", () => appStore.loadSettings());
export const useMe = () => useLazy("me", () => appStore.loadMe());
export const useNotificationPrefs = () => useLazy("notificationPrefs", () => appStore.loadNotificationPrefs());
export const useBilling = () => useLazy("billing", () => appStore.loadBilling());
export const useSeats = () => useLazy("seats", () => appStore.loadSeats());
export const useRoster = (enabled = true) => useLazy("roster", () => appStore.loadRoster(), [], enabled);
export const useOnboarding = () => useLazy("onboarding", () => appStore.loadOnboarding());
export const useIgnoreList = () => useLazy("ignoreList", () => appStore.loadIgnoreList());
export const useDataSummary = () => useLazy("dataSummary", () => appStore.loadDataSummary());

/**
 * One conversation (GET /threads/:id). `thread` is the full detail; `row` is
 * the inbox row (partial: one preview message, no draft) for instant headers.
 * Unknown ids resolve to `notFound` — the route itself always renders 200.
 */
export function useThread(threadId: string | null | undefined) {
  const snapshot = useApp();
  useEffect(() => {
    if (threadId) void appStore.loadThread(threadId);
  }, [threadId, snapshot.epoch]);
  const slice = threadId ? snapshot.details[threadId] : undefined;
  // No reload: the store applies every thread write to the detail itself.
  return {
    thread: slice?.data ?? null,
    row: threadId ? snapshot.threads.find((item) => item.id === threadId) ?? null : null,
    status: slice?.status ?? "idle",
    error: slice?.error ?? null,
    notFound: slice?.errorStatus === 404,
  } satisfies { thread: DemoThread | null; row: DemoThread | null; status: string; error: string | null; notFound: boolean };
}

/** Permission check for the signed-in seat; `undefined` until GET /me answers (hide, never show-then-refuse). */
export function useCan(action: PermissionAction): boolean | undefined {
  const me = useMe();
  return me.data ? can(me.data.role, action) : undefined;
}

export { apiStore } from "./api-store";
export type { AppSnapshot, AppStoreApi, DemoLedgerEntry, DemoMessage, DemoThread, Slice } from "./types";
