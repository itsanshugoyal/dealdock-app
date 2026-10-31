"use client";

import { useEffect, useState, type HTMLAttributes, type ReactNode } from "react";
import { CURRENCY_SYMBOL, formatMoneyCompact, formatMoneyExact, formatMoneyRange, type MoneyContext } from "@dealdock/core";
import { useReducedMotion } from "../../lib/keyboard";
import { useMoneyContext } from "../../lib/use-demo";
import { cx } from "./cx";

export type MoneyMode = "exact" | "compact" | "range";
export type MoneyKind = "confirmed" | "estimate" | "neutral";
export type MoneySize = "hero" | "lg" | "row" | "inline";

export interface MoneyValueProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  /** Integer minor units in the org currency. */
  minor: number;
  /** When present (and different), renders a range: ₹2L–₹4L. */
  maxMinor?: number | null;
  /** exact ₹1,20,000 (ledger, sheets, hero) · compact ₹3.2L (rows, charts) · range ₹2L–₹4L (estimates). */
  mode?: MoneyMode;
  /** confirmed → recovered green · estimate → "est." + muted · neutral → ink (offers, goals). */
  kind?: MoneyKind;
  size?: MoneySize;
  /**
   * Estimates show a visible "est." first. Rows whose layout already reads as an
   * estimate turn it off; screen readers still hear "estimated".
   */
  estimatePrefix?: boolean;
  /** Explicit money context (the onboarding region preview); defaults to the org's. */
  ctx?: MoneyContext;
}

const SIZE: Record<MoneySize, string> = { hero: "text-money-hero", lg: "text-money-lg", row: "text-money-row", inline: "" };
const KIND: Record<MoneyKind, string> = { confirmed: "text-recovered", estimate: "text-estimate", neutral: "text-ink" };

/** Formats with the @dealdock/core formatters only; "—" for invalid amounts instead of throwing mid-render. */
export function formatMoney(minor: number, maxMinor: number | null | undefined, mode: MoneyMode, ctx: MoneyContext): string {
  try {
    if (mode === "range" && maxMinor != null && maxMinor !== minor) return formatMoneyRange(minor, maxMinor, ctx);
    return mode === "exact" ? formatMoneyExact(minor, ctx) : formatMoneyCompact(minor, ctx);
  } catch {
    return "—";
  }
}

/**
 * The ONLY way money renders (DESIGN §3.4). Always carries class `money`.
 * Never use it to show ₹0 while loading — render a Skeleton instead.
 */
export function MoneyValue({ minor, maxMinor, mode, kind, size = "inline", estimatePrefix = true, ctx, className, ...rest }: MoneyValueProps) {
  const { money } = useMoneyContext();
  const context = ctx ?? money;
  const resolved: MoneyMode = mode ?? (maxMinor != null && maxMinor !== minor ? "range" : "compact");
  const text = formatMoney(minor, maxMinor, resolved, context);
  const symbol = CURRENCY_SYMBOL[context.currency];
  const single = resolved !== "range" || maxMinor == null || maxMinor === minor;
  const body: ReactNode = size === "hero" && single && text.startsWith(symbol)
    ? <><span className="dd-symbol-hero">{symbol}</span>{text.slice(symbol.length)}</>
    : text;
  return (
    <span className={cx("money", SIZE[size], kind && KIND[kind], className)} {...rest}>
      {kind === "estimate" && <>{estimatePrefix && <span aria-hidden>est. </span>}<span className="sr-only">estimated </span></>}
      {body}
    </span>
  );
}

const counted = new Set<string>();

/**
 * Hero count-up (DESIGN §2.7): 0 → value over 700 ms, once per page session
 * per `countId`. The accessible text is always the final value (sr-only twin);
 * the animated copy is aria-hidden and collapses to one plain value when done.
 */
export function MoneyCounter({ countId, minor, ...props }: MoneyValueProps & { countId: string }) {
  const reduced = useReducedMotion();
  const [current, setCurrent] = useState<number | null>(() => (counted.has(countId) ? null : 0));
  const { money } = useMoneyContext();
  useEffect(() => {
    if (counted.has(countId) || reduced || minor <= 0) {
      counted.add(countId);
      setCurrent(null);
      return;
    }
    counted.add(countId);
    const start = performance.now();
    let frame = requestAnimationFrame(function step(time) {
      const progress = Math.min(1, (time - start) / 700);
      if (progress >= 1) { setCurrent(null); return; }
      setCurrent(Math.round(minor * (1 - Math.pow(1 - progress, 3))));
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [countId, minor, reduced]);
  if (current === null) return <MoneyValue minor={minor} {...props} />;
  const { "data-testid": testId, id, ...visual } = props as MoneyValueProps & { "data-testid"?: string };
  return (
    <span className="inline-block">
      <MoneyValue {...visual} minor={current} aria-hidden="true" />
      <span className="money sr-only" id={id} data-testid={testId}>{formatMoney(minor, props.maxMinor, props.mode ?? "exact", props.ctx ?? money)}</span>
    </span>
  );
}
