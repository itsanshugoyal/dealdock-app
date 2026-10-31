"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { CloudOff, RefreshCw, TriangleAlert, type LucideIcon } from "lucide-react";
import { formatTime } from "../../lib/format";
import { useOnline } from "../../lib/keyboard";
import { appStore, useApp } from "../../lib/use-demo";
import { Button } from "./button";
import { cx } from "./cx";

/** A content-shaped placeholder block. Never show zeros or "all clear" while loading. */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cx("dd-skeleton block", className)} />;
}

/** Empty state (DESIGN §3.5): an optional glyph, a plain title, what to do next and an optional action. */
export function EmptyState({ icon: Icon, title, description, action, as: Title = "h2", className }: {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  as?: "h1" | "h2" | "h3" | "p";
  className?: string;
}) {
  return (
    <div className={cx("flex flex-col items-center px-4 py-10 text-center", className)}>
      {Icon && (
        <span aria-hidden className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-inset text-ink-2">
          <Icon size={24} />
        </span>
      )}
      <Title className="max-w-[32ch] text-balance text-heading text-ink">{title}</Title>
      {description && <p className="mt-2 max-w-[44ch] text-body text-ink-2">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** "Couldn't load {thing}." + plain reason + Try again (DESIGN §3.5). */
export function ErrorState({ thing, reason, onRetry, retryLabel = "Try again", secondary, as: Title = "h2", className }: {
  /** Lower-case object: "your inbox", "Today", "this conversation". */
  thing: string;
  reason?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  secondary?: ReactNode;
  as?: "h1" | "h2" | "h3" | "p";
  className?: string;
}) {
  return (
    <div role="alert" className={cx("flex flex-col items-center px-4 py-10 text-center", className)}>
      <TriangleAlert aria-hidden size={24} className="mb-3 text-danger" />
      <Title className="text-heading text-ink">Couldn&apos;t load {thing}.</Title>
      {reason && <p className="mt-2 max-w-[44ch] text-body text-ink-2">{reason}</p>}
      {(onRetry || secondary) && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {onRetry && <Button variant="primary" icon={RefreshCw} onClick={onRetry}>{retryLabel}</Button>}
          {secondary}
        </div>
      )}
    </div>
  );
}

/**
 * Offline banner (DESIGN §3.5): shows what you saw and that sending is paused;
 * on reconnect says "Back online. Refreshing…" for 2 s and refreshes quietly.
 */
export function OfflineBanner({ className }: { className?: string }) {
  const online = useOnline();
  const { loadedAt, money, timezone } = useApp();
  const [back, setBack] = useState(false);
  const wasOffline = useRef(false);
  useEffect(() => {
    if (!online) { wasOffline.current = true; return; }
    if (!wasOffline.current) return;
    wasOffline.current = false;
    setBack(true);
    void appStore.refresh();
    const timer = setTimeout(() => setBack(false), 2_000);
    return () => clearTimeout(timer);
  }, [online]);
  if (online && !back) return null;
  return (
    <div role="status" className={cx("flex items-center gap-2 bg-inset px-4 py-2 text-caption text-ink-2", className)}>
      <CloudOff aria-hidden size={16} className="shrink-0" />
      {online
        ? "Back online. Refreshing…"
        : loadedAt
          ? `Offline — showing what you saw at ${formatTime(loadedAt, money.locale ?? "en-IN", timezone)}. Sending is paused.`
          : "Offline. Sending is paused."}
    </div>
  );
}
