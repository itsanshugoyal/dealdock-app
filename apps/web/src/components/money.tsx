"use client";

import {
  formatMoneyCompact,
  formatMoneyExact,
  formatMoneyRange,
  type MoneyContext,
} from "@dealdock/core";
import { useDemoData } from "../lib/use-demo";

/**
 * Locale-aware money — the ONLY way money renders in the app (DESIGN.md §2.2).
 * Defaults to the org's region (demo store); explicit ctx overrides (used by
 * the onboarding region step's live preview).
 */
export function MoneyValue({
  minor,
  maxMinor,
  exact = false,
  ctx,
  className = "",
}: {
  minor: number;
  /** When present, renders a range: ₹2L–₹4L */
  maxMinor?: number | null;
  exact?: boolean;
  ctx?: MoneyContext;
  className?: string;
}) {
  const { money } = useDemoData();
  const effective = ctx ?? money;
  const text =
    maxMinor != null && maxMinor !== minor
      ? formatMoneyRange(minor, maxMinor, effective)
      : exact
        ? formatMoneyExact(minor, effective)
        : formatMoneyCompact(minor, effective);
  return <span className={`money ${className}`}>{text}</span>;
}
