"use client";

import { useRef, useState, type ComponentPropsWithRef, type ReactNode } from "react";
import { LoaderCircle, type LucideIcon } from "lucide-react";
import { ariaShortcut, buttonClasses, type ButtonSize, type ButtonVariant } from "./button-classes";
import { cx } from "./cx";
import { Kbd } from "./kbd";

export { ariaShortcut, buttonClasses, type ButtonSize, type ButtonVariant } from "./button-classes";

export interface ButtonProps extends ComponentPropsWithRef<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  iconRight?: LucideIcon;
  /** Keeps the width, shows a spinner and the present-participle label ("Saving…"). */
  loading?: boolean;
  loadingLabel?: ReactNode;
  fullWidth?: boolean;
  /** Shortcut shown as a key cap (decorative; also set `aria-keyshortcuts`). */
  kbd?: string;
}

export function Button({ variant = "secondary", size = "md", icon: Icon, iconRight: IconRight, loading = false, loadingLabel, fullWidth, kbd, className, children, disabled, type = "button", ...rest }: ButtonProps) {
  const iconSize = size === "sm" ? 16 : 20;
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClasses({ variant, size, fullWidth, className })}
      {...rest}
    >
      {loading ? <LoaderCircle size={16} className="dd-spin shrink-0" /> : Icon && <Icon size={iconSize} className="shrink-0" />}
      <span className="truncate">{loading && loadingLabel ? loadingLabel : children}</span>
      {IconRight && !loading && <IconRight size={iconSize} className="shrink-0" />}
      {kbd && <Kbd keys={kbd} className="ml-1" />}
    </button>
  );
}

export interface IconButtonProps extends Omit<ComponentPropsWithRef<"button">, "children"> {
  /** The accessible name (verb + object: "Move @nykaa to waiting"). Also the tooltip. */
  label: string;
  icon: LucideIcon;
  variant?: "ghost" | "secondary";
  size?: "sm" | "md";
  /** Toggle buttons expose aria-pressed. */
  pressed?: boolean;
  /** Shortcut shown in the tooltip, e.g. "w" or "mod+k". */
  shortcut?: string;
  tooltip?: boolean;
}

/** Icon-only button: 32/40 px square, 44 px hit area on touch, tooltip after 500 ms on hover or keyboard focus. */
export function IconButton({ label, icon: Icon, variant = "ghost", size = "md", pressed, shortcut, tooltip = true, className, type = "button", onPointerEnter, onPointerLeave, onFocus, onBlur, ...rest }: IconButtonProps) {
  const [tip, setTip] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = () => {
    if (!tooltip) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setTip(true), 500);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setTip(false);
  };
  return (
    <span className="relative inline-flex">
      <button
        type={type}
        aria-label={label}
        aria-pressed={pressed}
        aria-keyshortcuts={shortcut ? ariaShortcut(shortcut) : undefined}
        className={cx(
          "dd-press dd-hit inline-flex shrink-0 items-center justify-center rounded-full disabled:opacity-40",
          size === "sm" ? "h-8 w-8" : "h-10 w-10",
          variant === "secondary" ? "bg-inset text-ink hover:bg-fill" : "text-ink-2 hover:bg-inset hover:text-ink",
          pressed && "bg-inset text-ink",
          className,
        )}
        onPointerEnter={(event) => { if (event.pointerType === "mouse") show(); onPointerEnter?.(event); }}
        onPointerLeave={(event) => { hide(); onPointerLeave?.(event); }}
        onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) show(); onFocus?.(event); }}
        onBlur={(event) => { hide(); onBlur?.(event); }}
        {...rest}
      >
        <Icon size={size === "sm" ? 16 : 20} />
      </button>
      {tip && (
        <span aria-hidden className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-sm bg-primary px-2 py-1 text-caption text-on-primary shadow-raised">
          {label}
          {shortcut && <Kbd keys={shortcut} />}
        </span>
      )}
    </span>
  );
}
