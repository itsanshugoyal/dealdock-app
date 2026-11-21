"use client";

import { usePathname } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { InboxPane } from "../../components/inbox-pane";
import { cx } from "../../components/ui/cx";

/**
 * The desk: one conversation list for every width. Large screens keep it
 * beside whatever is open; phones show the list on /inbox and only the
 * conversation on /thread/:id.
 */
export default function DeskLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "";
  const threadId = pathname.startsWith("/thread/") ? decodeURIComponent(pathname.split("/")[2] ?? "") : null;
  return (
    // The shell gives desk routes a viewport-tall column on large screens, so `h-full` here
    // leaves room for any banner above (demo, offline, errors) instead of overflowing by its height.
    <div className="lg:grid lg:h-full lg:grid-cols-[400px_minmax(0,1fr)] xl:grid-cols-[460px_minmax(0,1fr)]">
      <Suspense fallback={<div className="hidden lg:block" />}>
        <InboxPane className={cx("lg:flex lg:h-full lg:border-r lg:border-hairline", threadId && "hidden")} selectedId={threadId} headingLevel={threadId ? "h2" : "h1"} />
      </Suspense>
      <div className={cx("min-w-0 lg:h-full lg:overflow-y-auto", !threadId && "hidden lg:block")} id="desk-detail">{children}</div>
    </div>
  );
}
