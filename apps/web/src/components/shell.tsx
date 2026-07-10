"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useDemoData } from "../lib/use-demo";

const TABS = [
  { href: "/", label: "Home", icon: "◆" },
  { href: "/inbox", label: "Inbox", icon: "▤" },
  { href: "/review", label: "Review", icon: "?" },
  { href: "/ledger", label: "Ledger", icon: "₹" },
  { href: "/settings", label: "Settings", icon: "⚙" },
];

/**
 * App shell (DESIGN.md §3): bottom tabs on mobile, left rail on desktop.
 * The Review tab badge makes the queue impossible to forget (PRD §5.5).
 */
export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { threads } = useDemoData();
  const reviewCount = threads.filter(
    (t) => t.routedTo === "review_queue" && !t.reviewed
  ).length;

  // Onboarding is a focused full-screen flow — no tabs, no rail (DESIGN.md §4.1).
  if (pathname.startsWith("/onboarding")) {
    return <div className="min-h-dvh">{children}</div>;
  }

  const nav = (vertical: boolean) => (
    <nav
      className={
        vertical
          ? "flex flex-col gap-1 p-3"
          : "flex items-stretch justify-around border-t border-white/[0.07] bg-[#0a0a0a]/95 backdrop-blur"
      }
    >
      {TABS.map((tab) => {
        const active =
          tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-label={tab.label}
            className={`relative flex min-h-11 min-w-11 items-center gap-3 rounded-xl px-3 py-2 text-[13px] transition-colors ${
              vertical ? "" : "flex-1 flex-col justify-center gap-0.5 rounded-none py-2"
            } ${active ? "text-[#fafafa]" : "text-[#737373] hover:text-[#a3a3a3]"} ${
              active && vertical ? "bg-white/[0.06]" : ""
            }`}
          >
            <span aria-hidden className="text-[15px] leading-none">{tab.icon}</span>
            <span className={vertical ? "font-medium" : "text-[10px] font-medium"}>
              {tab.label}
            </span>
            {tab.href === "/review" && reviewCount > 0 && (
              <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#eab308] px-1 text-[9px] font-bold text-[#050505]">
                {reviewCount > 99 ? "99+" : reviewCount}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-dvh">
      {/* Desktop rail */}
      <aside className="hidden w-52 shrink-0 border-r border-white/[0.07] bg-[#0a0a0a] md:block">
        <div className="flex items-center gap-2 p-4">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#ffc107] text-[13px] font-black text-[#050505]">
            ₹
          </span>
          <span className="text-sm font-bold">DealDock</span>
        </div>
        {nav(true)}
        <p className="px-4 pt-6 text-[10px] uppercase tracking-widest text-[#404040]">
          Demo mode · mock data
        </p>
        <Link
          href="/onboarding"
          className="mx-3 mt-2 block rounded-lg px-3 py-2 text-[11px] text-[#525252] transition-colors hover:bg-white/[0.04] hover:text-[#a3a3a3]"
        >
          ▶ Replay onboarding demo
        </Link>
      </aside>

      {/* Content */}
      <div className="flex min-w-0 flex-1 flex-col pb-16 md:pb-0">{children}</div>

      {/* Mobile bottom tabs */}
      <div className="fixed inset-x-0 bottom-0 z-40 md:hidden">{nav(false)}</div>
    </div>
  );
}
