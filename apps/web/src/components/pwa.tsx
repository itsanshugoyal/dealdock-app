"use client";

import { useEffect, useState } from "react";
import { useDemoData } from "../lib/use-demo";
import { MoneyValue } from "./money";

/** Registers the service worker once on mount. */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // SW registration failing must never break the app.
      });
    }
  }, []);
  return null;
}

const PROMPT_DISMISSED_KEY = "dealdock-push-prompt-dismissed";
const HIGH_VALUE_MINOR = 10_000_000; // ₹1L / $1.2K-scale — the "that mattered" bar

/**
 * Contextual push permission (DESIGN.md §4.1.7): NEVER asked on load —
 * the sheet appears the first time the user is looking at a high-value
 * thread, when the value of knowing-immediately is self-evident.
 */
export function PushPrompt({ threadValueMinor }: { threadValueMinor: number | null }) {
  const { money } = useDemoData();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!threadValueMinor || threadValueMinor < HIGH_VALUE_MINOR) return;
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "default") return;
    if (localStorage.getItem(PROMPT_DISMISSED_KEY)) return;
    const timer = setTimeout(() => setVisible(true), 1200);
    return () => clearTimeout(timer);
  }, [threadValueMinor]);

  if (!visible || !threadValueMinor) return null;

  const enable = async () => {
    setVisible(false);
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const vapid = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if (!vapid) return; // demo mode: permission granted, real subscribe needs API
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapid,
      });
      const api = process.env.NEXT_PUBLIC_API_URL;
      if (api) {
        await fetch(`${api}/notifications/subscribe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sub.toJSON()),
        });
      }
    } catch {
      // Push is best-effort by design (ADR-10) — nothing critical depends on it.
    }
  };

  return (
    <div className="fixed inset-x-4 bottom-20 z-50 mx-auto max-w-sm rounded-2xl border border-white/[0.1] bg-[#161616] p-4 shadow-[0_12px_40px_rgba(0,0,0,0.6)] md:bottom-6">
      <p className="text-[13px] font-semibold text-[#fafafa]">
        That was a <MoneyValue minor={threadValueMinor} ctx={money} className="text-[#ffc107]" /> deal.
      </p>
      <p className="mt-1 text-[12px] leading-relaxed text-[#737373]">
        Want to know the moment the next one arrives? Brands expect replies within 24 hours.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          onClick={enable}
          className="min-h-10 flex-1 rounded-full bg-[#ffc107] text-[13px] font-bold text-[#050505] hover:bg-[#e5a800]"
        >
          Notify me
        </button>
        <button
          onClick={() => {
            localStorage.setItem(PROMPT_DISMISSED_KEY, "1");
            setVisible(false);
          }}
          className="min-h-10 rounded-full border border-white/[0.1] px-4 text-[13px] text-[#737373]"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
