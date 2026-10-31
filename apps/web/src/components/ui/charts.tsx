"use client";

import type { ReactNode } from "react";
import type { DealType } from "@dealdock/core";
import { cx } from "./cx";
import { DEAL_TYPE_FILL } from "./label-chip";

/**
 * Hand-written SVG/HTML charts (DESIGN §3.4) — no chart library. Every chart
 * carries its information in text too (aria-label, value labels, sr tables);
 * colour is never the only carrier.
 */

/** 6-point trend, no axes. `label` summarises it for screen readers. */
export function Sparkline({ values, label, width = 160, height = 40, className }: { values: number[]; label: string; width?: number; height?: number; className?: string }) {
  const max = Math.max(0, ...values);
  const pad = 3;
  const points = values.map((value, index) => {
    const x = values.length > 1 ? pad + (index / (values.length - 1)) * (width - pad * 2) : width / 2;
    const y = max > 0 ? height - pad - (value / max) * (height - pad * 2) : height / 2;
    return [x, y] as const;
  });
  const last = points[points.length - 1];
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${width} ${height}`} width={width} height={height} className={cx("max-w-full overflow-visible", className)}>
      {max > 0 && points.length > 1 ? (
        <>
          <polyline points={points.map(([x, y]) => `${x},${y}`).join(" ")} className="fill-none stroke-recovered" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {last && <circle cx={last[0]} cy={last[1]} r={2.5} className="fill-recovered" />}
        </>
      ) : (
        <line x1={pad} x2={width - pad} y1={height / 2} y2={height / 2} className="stroke-hairline" strokeWidth={1} />
      )}
    </svg>
  );
}

export interface BarDatum {
  key: string;
  /** Short axis label under the bar ("Oct"). */
  label: string;
  value: number;
  /** Value label above the bar — pass a <MoneyValue mode="compact"/>. */
  top?: ReactNode;
  /** Full accessible name: "October 2026, ₹3.2L recovered, 4 sales". */
  ariaLabel: string;
}

/** Vertical bars; each bar is a button that selects its key (Revenue month trend). */
export function Bars({ data, selectedKey, onSelect, label, className }: { data: BarDatum[]; selectedKey?: string; onSelect?: (key: string) => void; label: string; className?: string }) {
  const max = Math.max(1, ...data.map((item) => item.value));
  return (
    <div role="group" aria-label={label} className={cx("flex min-w-[200px] items-end justify-between gap-2", className)}>
      {data.map((item) => {
        const selected = item.key === selectedKey;
        return (
          <button
            key={item.key}
            type="button"
            aria-label={item.ariaLabel}
            aria-pressed={onSelect ? selected : undefined}
            disabled={!onSelect}
            onClick={() => onSelect?.(item.key)}
            className="dd-press flex min-w-6 max-w-10 flex-1 flex-col items-center gap-1 rounded-sm disabled:cursor-default"
          >
            <span aria-hidden className="text-caption text-ink-3">{item.top}</span>
            <span aria-hidden className="flex h-28 w-full items-end">
              <span className={cx("block w-full rounded-t-[4px]", selected ? "bg-recovered" : "bg-chart-muted")} style={{ height: `${Math.max(item.value > 0 ? 3 : 1, (item.value / max) * 100)}%` }} />
            </span>
            <span aria-hidden className={cx("text-caption", selected ? "text-ink" : "text-ink-3")}>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** One 12 px bar split by deal type; pair it with a legend list that carries the numbers. */
export function StackedBar({ segments, label, className }: { segments: Array<{ type: DealType; value: number }>; label: string; className?: string }) {
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0);
  return (
    <div role="img" aria-label={label} className={cx("flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-inset", className)}>
      {total > 0 && segments.filter((segment) => segment.value > 0).map((segment) => (
        <span key={segment.type} className={cx("h-full", DEAL_TYPE_FILL[segment.type])} style={{ width: `${(segment.value / total) * 100}%` }} />
      ))}
    </div>
  );
}

/** Goal ring: 64 px (Today) / 96 px (Revenue). `label`: "62% of your ₹5L goal. On pace for ₹5.4L." */
export function ProgressRing({ pct, projectedPct, size = 64, label, className }: { pct: number; projectedPct?: number | null; size?: 64 | 96; label: string; className?: string }) {
  const stroke = size === 96 ? 8 : 6;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.max(0, Math.min(100, pct));
  const tick = projectedPct === null || projectedPct === undefined ? null : (Math.max(0, Math.min(100, projectedPct)) / 100) * 2 * Math.PI - Math.PI / 2;
  const center = size / 2;
  return (
    <div role="img" aria-label={label} className={cx("relative inline-flex shrink-0 items-center justify-center", className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={center} cy={center} r={radius} className="fill-none stroke-hairline" strokeWidth={stroke} />
        <circle cx={center} cy={center} r={radius} className="fill-none stroke-recovered" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - progress / 100)} />
      </svg>
      {tick !== null && (
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="absolute inset-0">
          <line
            x1={center + (radius - stroke) * Math.cos(tick)} y1={center + (radius - stroke) * Math.sin(tick)}
            x2={center + (radius + stroke) * Math.cos(tick)} y2={center + (radius + stroke) * Math.sin(tick)}
            className="stroke-ink-3" strokeWidth={2} strokeLinecap="round"
          />
        </svg>
      )}
      <span aria-hidden className="absolute text-subheading text-ink">{Math.round(pct)}%</span>
    </div>
  );
}
