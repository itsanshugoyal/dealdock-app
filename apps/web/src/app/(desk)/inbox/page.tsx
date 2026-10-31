"use client";

import { MessagesSquare } from "lucide-react";
import { needsYou, pluralize } from "../../../lib/format";
import { useApp } from "../../../lib/use-demo";
import { Kbd } from "../../../components/ui/kbd";

/** The list itself lives in the desk layout; on large screens this pane invites a pick. */
export default function InboxPage() {
  const { threads } = useApp();
  const waiting = threads.filter(needsYou).length;
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <span aria-hidden className="mb-5 flex h-16 w-16 items-center justify-center rounded-[20px] bg-surface text-ink-3 shadow-card"><MessagesSquare size={28} /></span>
      <p className="text-title text-ink">Pick a conversation</p>
      <p className="mt-1 max-w-sm text-body text-ink-2">{waiting} {pluralize(waiting, "needs", "need")} you, biggest first. Press <Kbd keys="j" /> to open the first one, then <Kbd keys="j" /> and <Kbd keys="k" /> to move between them.</p>
    </div>
  );
}
