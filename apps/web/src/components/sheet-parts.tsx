"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/** The last non-null value, so a closing sheet keeps showing what it was about through its exit. */
export function useLast<T>(value: T | null): T | null {
  const [last, setLast] = useState(value);
  useEffect(() => { if (value !== null) setLast(value); }, [value]);
  return value ?? last;
}

/** A collapsed group of optional fields (DESIGN: disclosures draw their own chevron). */
export function Disclosure({ summary, open, onToggle, children }: { summary: string; open: boolean; onToggle: (open: boolean) => void; children: ReactNode }) {
  return (
    <details open={open} onToggle={(event) => onToggle(event.currentTarget.open)} className="group border-t border-hairline">
      <summary className="dd-summary flex min-h-12 items-center justify-between gap-3 rounded-xl text-label font-semibold text-ink-2 hover:text-ink">
        {summary}<ChevronDown aria-hidden size={16} className="shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <div className="flex flex-col gap-4 pb-1 pt-1">{children}</div>
    </details>
  );
}

export function SaveError({ message, children }: { message: string | null; children?: ReactNode }) {
  return message ? <div role="alert" className="rounded-2xl bg-danger-tint px-3 py-2 text-[14px] text-danger"><p>{message}</p>{children}</div> : null;
}
