"use client";

import { useEffect, useState } from "react";
import type { ClassificationLabel } from "@dealdock/core";
import { accountBigOneThreshold, labelText } from "../lib/format";
import { apiStore, IS_DEMO_MODE, useAppSelector, useMoneyContext, type AppSnapshot } from "../lib/use-demo";
import { Button } from "./ui/button";
import { MoneyValue } from "./ui/money-value";

/** Registers the service worker once on mount. */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      // Development chunk URLs are mutable. A production cache-first worker
      // can otherwise serve stale code and prevent hydration after an edit.
      if ("serviceWorker" in navigator) void navigator.serviceWorker.getRegistrations().then(registrations => Promise.all(registrations.map(registration => registration.unregister())));
      return;
    }
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // SW registration failing must never break the app.
      });
    }
  }, []);
  return null;
}

/**
 * VAPID public keys are base64url strings; the Push API needs a BufferSource
 * (F14). Backed by an explicit ArrayBuffer so the value is a concrete
 * ArrayBuffer-backed view, not the widened Uint8Array<ArrayBufferLike>.
 */
function urlBase64ToBufferSource(base64: string): BufferSource {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const buffer = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return buffer;
}

/** Push setup is explicitly user initiated and only offered where the build has a key. */
export function pushConfigured(): boolean {
  return process.env.NODE_ENV === "production" && Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY) &&
    typeof window !== "undefined" && "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
}

export async function enablePush(): Promise<void> {
  if (!pushConfigured()) throw new Error("Push notifications are not configured or supported on this device.");
  const identity = await apiStore.preparePush();
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission === "denied") throw new Error("Notifications are blocked. Enable them in your browser settings.");
  if (permission !== "granted") throw new Error("Notification permission was not granted.");
  const vapid = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!;
  const registration = await navigator.serviceWorker.register("/sw.js");
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing ?? await registration.pushManager.subscribe({
    userVisibleOnly: true, applicationServerKey: urlBase64ToBufferSource(vapid),
  });
  try {
    apiStore.assertPushIdentity(identity);
    await apiStore.subscribePush(subscription.toJSON());
    apiStore.confirmPushIdentity(identity);
  } catch (error) {
    let identityChanged = false;
    try { apiStore.assertPushIdentity(identity); } catch { identityChanged = true; }
    // A new endpoint is not usable after a failed registration; an old endpoint
    // must also be removed if the user changed workspaces during this attempt.
    if (!existing || identityChanged) await subscription.unsubscribe().catch(() => false);
    throw error;
  }
}

type PromptState = "idle" | "denied" | "error";
const DISMISSED_KEY = "dealdock.push.prompt.dismissedAt";
const QUIET_MS = 30 * 24 * 60 * 60_000;

function dismissedRecently(): boolean {
  try { return Date.now() - Number(localStorage.getItem(DISMISSED_KEY) ?? 0) < QUIET_MS; } catch { return false; }
}
function rememberDismissal() {
  try { localStorage.setItem(DISMISSED_KEY, String(Date.now())); } catch { /* the prompt may return next session */ }
}

const selectOffers = (snapshot: AppSnapshot) => snapshot.offers.data;

/**
 * Contextual push ask (DESIGN §5.13): conversation pages only, after 1.2 s,
 * when push is configured, permission is undecided, the thread is a big one
 * by its account's push bar, and it wasn't dismissed in the last 30 days. Never steals focus.
 */
export function PushPrompt({ threadValueMinor, label, igAccountId = null }: { threadValueMinor: number | null; label?: ClassificationLabel | null; igAccountId?: string | null }) {
  const { money } = useMoneyContext();
  // Offers count once they are loaded (the inbox loads them); the prompt never fetches them.
  const offers = useAppSelector(selectOffers);
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<PromptState>("idle");
  const [busy, setBusy] = useState(false);
  const threshold = accountBigOneThreshold(money.currency, offers, igAccountId);

  useEffect(() => {
    if (IS_DEMO_MODE || !pushConfigured() || !threadValueMinor || threadValueMinor < threshold || Notification.permission === "granted" || dismissedRecently()) return;
    if (Notification.permission === "denied") setState("denied");
    const timer = setTimeout(() => setVisible(true), 1200);
    return () => clearTimeout(timer);
  }, [threadValueMinor, threshold]);

  if (!visible || !threadValueMinor) return null;
  const close = () => { rememberDismissal(); setVisible(false); };
  const enable = async () => {
    if (busy) return;
    setBusy(true);
    try { await enablePush(); setVisible(false); }
    catch { setState(Notification.permission === "denied" ? "denied" : "error"); }
    finally { setBusy(false); }
  };
  return (
    <aside aria-labelledby="push-prompt-title" className="fixed inset-x-0 bottom-0 z-50 mx-auto max-w-md rounded-t-xl border border-hairline bg-surface-raised p-4 pb-[max(16px,env(safe-area-inset-bottom))] shadow-raised md:bottom-6 md:rounded-xl">
      {state === "denied" ? <>
        <h2 id="push-prompt-title" className="text-heading text-ink">Notifications are blocked</h2>
        <p className="mt-1 text-body text-ink-2">Notifications are blocked for DealDock in your browser settings.</p>
        <div className="mt-4 flex justify-end"><Button variant="secondary" onClick={close}>Got it</Button></div>
      </> : <>
        <h2 id="push-prompt-title" className="text-heading text-ink">Know when the next one lands</h2>
        <p className="mt-1 text-body text-ink-2">
          {state === "error" ? "Couldn't turn on notifications. Try again, or use Settings." : <>That was a <MoneyValue minor={threadValueMinor} mode="compact" /> {label ? labelText(label).toLowerCase() : "enquiry"}. Want a notification when the next high-value enquiry arrives?</>}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>Not now</Button>
          <Button variant="primary" loading={busy} loadingLabel="Turning on…" onClick={() => void enable()}>{state === "error" ? "Try again" : "Notify me"}</Button>
        </div>
      </>}
    </aside>
  );
}
