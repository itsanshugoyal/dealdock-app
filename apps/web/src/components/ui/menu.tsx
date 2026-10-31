"use client";

import { Fragment, useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Check, Ellipsis, type LucideIcon } from "lucide-react";
import { ariaShortcut } from "./button";
import { cx } from "./cx";
import { Kbd } from "./kbd";
import { usePopover } from "./popover";

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  kbd?: string;
  destructive?: boolean;
  disabled?: boolean;
  /** Radio-style items (e.g. theme) show a check and expose aria-checked. */
  checked?: boolean;
}

/**
 * Menu (DESIGN §3.2): Popover API anchored to its trigger; role=menu,
 * arrow keys, Home/End, type-ahead, Escape returns focus to the trigger.
 * Destructive items sit last, separated by a hairline.
 */
export function Menu({ label, items, icon: Icon = Ellipsis, align = "end", trigger, header, className }: {
  /** Accessible name of the trigger and the menu ("More actions for @nykaa"). */
  label: string;
  items: MenuItem[];
  icon?: LucideIcon;
  align?: "start" | "end";
  /** Custom trigger content; receives the props that wire it to the popover. */
  trigger?: (props: ReturnType<typeof usePopover>["triggerProps"] & { "aria-haspopup": "menu"; "aria-label"?: string }) => ReactNode;
  /** Non-interactive caption at the top (e.g. workspace + role). */
  header?: ReactNode;
  className?: string;
}) {
  const popover = usePopover(align);
  const list = useRef<HTMLDivElement>(null);
  const safe = items.filter((item) => !item.destructive);
  const destructive = items.filter((item) => item.destructive);
  const focusables = () => [...(list.current?.querySelectorAll<HTMLButtonElement>("[role^=menuitem]:not(:disabled)") ?? [])];

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = focusables();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const move = (next: number) => { event.preventDefault(); buttons[(next + buttons.length) % buttons.length]?.focus(); };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(buttons.length - 1);
    else if (event.key.length === 1 && /\S/.test(event.key)) {
      const letter = event.key.toLowerCase();
      const match = buttons.findIndex((button, i) => i > index && button.textContent?.trim().toLowerCase().startsWith(letter));
      const wrapped = match >= 0 ? match : buttons.findIndex((button) => button.textContent?.trim().toLowerCase().startsWith(letter));
      if (wrapped >= 0) move(wrapped);
    }
  };

  const row = (item: MenuItem) => (
    <button
      key={item.label}
      type="button"
      role={item.checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={item.checked}
      aria-keyshortcuts={item.kbd ? ariaShortcut(item.kbd) : undefined}
      tabIndex={-1}
      disabled={item.disabled}
      className={cx(
        "flex min-h-9 w-full items-center gap-2 rounded-md px-3 text-left text-body outline-offset-[-2px] hover:bg-inset focus-visible:bg-inset disabled:opacity-45 [@media(pointer:coarse)]:min-h-11",
        item.destructive ? "text-danger" : "text-ink",
      )}
      onClick={() => { popover.close(); item.onSelect(); }}
    >
      {item.icon && <item.icon size={16} className="shrink-0" />}
      <span className="flex-1">{item.label}</span>
      {item.checked && <Check size={16} className="shrink-0 text-ink-2" />}
      {item.kbd && <Kbd keys={item.kbd} />}
    </button>
  );

  useEffect(() => {
    if (popover.open) focusables()[0]?.focus();
    // focusables reads the DOM each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popover.open]);

  const triggerProps = { ...popover.triggerProps, "aria-haspopup": "menu" as const };
  return (
    <>
      {trigger ? trigger({ ...triggerProps, "aria-label": label }) : (
        <button
          type="button"
          {...triggerProps}
          aria-label={label}
          className={cx("dd-press dd-hit inline-flex h-10 w-10 items-center justify-center rounded-md text-ink-2 hover:bg-inset hover:text-ink", className)}
        >
          <Icon size={20} />
        </button>
      )}
      <div
        {...popover.popoverProps}
        ref={(element) => {
          popover.popoverProps.ref(element);
          list.current = element as HTMLDivElement | null;
        }}
        role="menu"
        aria-label={label}
        className="dd-popover min-w-52"
        onKeyDown={onKeyDown}
      >
        {popover.open && (
          <>
            {header && <div className="border-b border-hairline px-3 pb-2 pt-1.5 text-caption text-ink-3">{header}</div>}
            {safe.map(row)}
            {destructive.length > 0 && <Fragment><div role="separator" className="my-1 h-px bg-hairline" />{destructive.map(row)}</Fragment>}
          </>
        )}
      </div>
    </>
  );
}
