import { cx } from "./cx";

/* Server-safe (no "use client"): server components such as not-found.tsx style links with these. */

/**
 * "danger-ghost" is a quiet destructive action ("Delete voice"); a ghost plus a text-danger class can't do it,
 * since cx doesn't merge utilities and ghost's own text colour wins. "hero" and "on-hero" are for actions
 * inside a HeroCard (kit.tsx), which looks the same in both themes.
 */
export type ButtonVariant = "primary" | "money" | "secondary" | "tinted" | "ghost" | "danger" | "danger-ghost" | "hero" | "on-hero";
export type ButtonSize = "sm" | "md" | "lg";
const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-primary text-on-primary shadow-[0_1px_0_rgba(255,255,255,0.12)_inset,0_6px_16px_-8px_rgba(0,0,0,0.45)] hover:bg-[color-mix(in_oklab,var(--dd-ink)_86%,var(--dd-canvas))]",
  money: "bg-brand text-on-brand shadow-[0_1px_0_rgba(255,255,255,0.18)_inset,0_8px_20px_-10px_var(--dd-brand)] hover:bg-brand-strong",
  secondary: "bg-inset text-ink hover:bg-fill",
  tinted: "bg-brand-tint text-recovered hover:bg-[color-mix(in_oklab,var(--dd-brand-tint)_80%,var(--dd-brand))]",
  ghost: "bg-transparent text-ink-2 hover:bg-inset hover:text-ink",
  danger: "bg-danger text-on-danger hover:bg-[color-mix(in_oklab,var(--dd-danger)_88%,var(--dd-canvas))]",
  "danger-ghost": "bg-transparent text-danger hover:bg-danger-tint",
  hero: "bg-hero-accent text-on-hero-accent shadow-[0_10px_30px_-10px_color-mix(in_oklab,var(--dd-hero-accent)_80%,transparent)] hover:bg-hero-accent-strong",
  "on-hero": "bg-on-hero/10 text-on-hero hover:bg-on-hero/15",
};
const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 px-3.5 text-label font-semibold dd-hit",
  md: "h-11 gap-2 px-5 text-button",
  lg: "h-[52px] gap-2 px-6 text-button",
};

/** "mod+k" → "Meta+K Control+K" for aria-keyshortcuts. */
export function ariaShortcut(shortcut: string): string {
  const keys = shortcut.split("+").map((part) => (part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)));
  const text = keys.join("+");
  return /mod/i.test(shortcut) ? `${text.replace(/Mod/, "Meta")} ${text.replace(/Mod/, "Control")}` : text;
}

/** Button styles for non-button elements (a Next <Link> styled as a button). */
export function buttonClasses({ variant = "secondary", size = "md", fullWidth = false, className }: { variant?: ButtonVariant; size?: ButtonSize; fullWidth?: boolean; className?: string } = {}) {
  return cx(
    "dd-press inline-flex select-none items-center justify-center whitespace-nowrap rounded-full font-semibold tracking-[-0.006em]",
    "disabled:opacity-40 aria-disabled:opacity-40",
    VARIANTS[variant],
    SIZES[size],
    fullWidth && "w-full",
    className,
  );
}
