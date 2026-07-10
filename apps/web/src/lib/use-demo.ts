"use client";

import { useEffect, useSyncExternalStore } from "react";
import { demoStore } from "./demo-store";

const SERVER_SNAPSHOT: ReturnType<typeof demoStore.getSnapshot> = {
  threads: [],
  ledger: [],
  money: { currency: "INR", locale: "en-IN" },
  onboarded: true,
};

export function useDemoData() {
  useEffect(() => {
    void demoStore.init();
  }, []);

  return useSyncExternalStore(
    demoStore.subscribe,
    demoStore.getSnapshot,
    () => SERVER_SNAPSHOT
  );
}

export { demoStore, DEMO_MONEY, isNudgeDue } from "./demo-store";
export type { DemoThread, DemoLedgerEntry, DemoMessage } from "./demo-store";
