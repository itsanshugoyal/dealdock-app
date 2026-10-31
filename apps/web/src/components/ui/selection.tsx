"use client";

import { useRef, type ComponentPropsWithRef, type KeyboardEvent, type ReactNode } from "react";
import { LoaderCircle, type LucideIcon } from "lucide-react";
import { cx } from "./cx";

/** Arrow/Home/End roving focus across sibling options; returns the index to activate or -1. */
function rove(event: KeyboardEvent, count: number, index: number): number {
  const next = event.key === "ArrowRight" || event.key === "ArrowDown" ? index + 1
    : event.key === "ArrowLeft" || event.key === "ArrowUp" ? index - 1
    : event.key === "Home" ? 0 : event.key === "End" ? count - 1 : null;
  if (next === null) return -1;
  event.preventDefault();
  return (next + count) % count;
}

/**
 * Segmented control (DESIGN §3.3): role=radiogroup, ≤ 4 options, arrow keys
 * move the selection. For changing a value (theme, period, undo window).
 */
export function Segmented<T extends string>({ label, value, options, onChange, disabled, className }: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: ReactNode }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  const group = useRef<HTMLDivElement>(null);
  const current = Math.max(0, options.findIndex((option) => option.value === value));
  return (
    <div ref={group} role="radiogroup" aria-label={label} className={cx("inline-flex rounded-full bg-inset p-1", className)}>
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={index === current ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              const next = rove(event, options.length, index);
              if (next < 0) return;
              onChange(options[next]!.value);
              group.current?.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
            }}
            className={cx(
              "dd-press dd-hit h-8 rounded-full px-3 text-label disabled:opacity-45",
              checked ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:text-ink",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export interface ChipProps extends ComponentPropsWithRef<"button"> {
  /** Toggle chips expose aria-pressed; leave undefined for action chips. */
  pressed?: boolean;
  variant?: "toggle" | "action";
  icon?: LucideIcon;
  count?: ReactNode;
  /** Action chips show a spinner in place of their icon while their request runs. */
  loading?: boolean;
}

/** Pill chip (DESIGN §3.3): filters and draft steering. */
export function Chip({ pressed, variant = "toggle", icon: Icon, count, loading = false, className, children, type = "button", disabled, ...rest }: ChipProps) {
  const on = variant === "toggle" && pressed;
  return (
    <button
      type={type}
      aria-pressed={variant === "toggle" ? Boolean(pressed) : undefined}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={cx(
        "dd-press dd-hit inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-label disabled:opacity-45",
        on ? "border-transparent bg-primary text-on-primary" : "border-hairline bg-surface text-ink-2 hover:bg-inset hover:text-ink",
        className,
      )}
      {...rest}
    >
      {loading ? <LoaderCircle size={16} className="dd-spin" /> : Icon && <Icon size={16} />}
      {children}
      {count !== undefined && count !== null && <span className={on ? "text-on-primary" : "text-ink-3"}>{count}</span>}
    </button>
  );
}
