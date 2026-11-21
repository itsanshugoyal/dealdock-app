"use client";

import Link from "next/link";
import Script from "next/script";
import { useState } from "react";
import { Logo } from "./kit";
import { buttonClasses } from "./ui/button";

type PaddleGlobal = {
  Environment: { set(env: "sandbox"): void };
  Initialize(options: { token: string; eventCallback?: (event: { name?: string }) => void }): void;
};

const TOKEN = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN ?? "";
const SANDBOX = process.env.NEXT_PUBLIC_PADDLE_ENV === "sandbox";

type Stage = "loading" | "open" | "paid" | "closed" | "unavailable";

const COPY: Record<Stage, { title: string; body: string }> = {
  loading: { title: "Opening secure checkout…", body: "Paddle, our payment partner, handles your card and any local tax." },
  open: { title: "Finish payment in the checkout", body: "Paddle, our payment partner, handles your card and any local tax." },
  paid: { title: "Payment received", body: "Your DealDock subscription is active. A receipt is on its way from Paddle." },
  closed: { title: "Checkout closed", body: "Nothing was charged. Open the payment link again from DealDock whenever you're ready." },
  unavailable: { title: "Checkout isn't available", body: "This payment link is missing or payments aren't set up yet. Reach us from the Contact page." },
};

/**
 * Paddle's default payment link. Paddle.js opens checkout by itself when the
 * address carries ?_ptxn=<transaction id>; this page only initialises it.
 */
export function PaddleCheckout() {
  const [stage, setStage] = useState<Stage>(TOKEN ? "loading" : "unavailable");

  const init = () => {
    const paddle = (window as unknown as { Paddle?: PaddleGlobal }).Paddle;
    if (!paddle || !TOKEN) return setStage("unavailable");
    if (SANDBOX) paddle.Environment.set("sandbox");
    paddle.Initialize({
      token: TOKEN,
      eventCallback: (event) => {
        if (event.name === "checkout.loaded") setStage("open");
        else if (event.name === "checkout.completed") setStage("paid");
        else if (event.name === "checkout.closed") setStage((s) => (s === "paid" ? s : "closed"));
      },
    });
    // No transaction in the address: Paddle.js has nothing to open.
    if (!new URLSearchParams(window.location.search).has("_ptxn")) setStage("unavailable");
  };

  const { title, body } = COPY[stage];
  return (
    <div className="mx-auto flex min-h-[70dvh] max-w-md flex-col items-center justify-center px-4 py-12 text-center">
      {TOKEN && <Script src="https://cdn.paddle.com/paddle/v2/paddle.js" onLoad={init} onError={() => setStage("unavailable")} />}
      <Logo size={52} />
      <h1 className="mt-6 text-display text-ink" aria-live="polite">{title}</h1>
      <p className="mt-2 text-body text-ink-2">{body}</p>
      {stage !== "loading" && stage !== "open" && (
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Link href="/" className={buttonClasses({ variant: "primary" })}>Back to DealDock</Link>
        </div>
      )}
    </div>
  );
}
