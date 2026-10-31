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
    <div className="lg:grid lg:h-dvh lg:grid-cols-[400px_minmax(0,1fr)] xl:grid-cols-[430px_minmax(0,1fr)]">
      <Suspense fallback={<div className="hidden lg:block" />}>
        <InboxPane className={cx("lg:flex lg:h-dvh lg:border-r lg:border-hairline", threadId && "hidden")} selectedId={threadId} headingLevel={threadId ? "h2" : "h1"} />
      </Suspense>
      <div className={cx("min-w-0 lg:h-dvh lg:overflow-y-auto", !threadId && "hidden lg:block")} id="desk-detail">{children}</div>
    </div>
  );
}
