"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { ArrowRight, MessageCircle, MessagesSquare } from "lucide-react";
import { byValueDesc, displayName, needsYou } from "../../../lib/format";
import { conversationHref, inboxView } from "../../../lib/inbox-navigation";
import { useApp } from "../../../lib/use-demo";
import { buttonClasses } from "../../../components/ui/button-classes";
import { Kbd } from "../../../components/ui/kbd";

/** The list itself lives in the desk layout; on large screens this pane invites a pick. */
export default function InboxPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <Suspense fallback={<PickConversation />}><Placeholder /></Suspense>
    </div>
  );
}

/** Comments are answered in the list itself, so their pane says so instead of asking for a pick. */
function Placeholder() {
  const params = useSearchParams();
  if (inboxView(params?.get("view")) !== "comments") return <PickConversation><StartWithBiggest /></PickConversation>;
  return (
    <>
      <span aria-hidden className="mb-5 flex h-16 w-16 items-center justify-center rounded-[20px] bg-surface text-ink-3 shadow-card"><MessageCircle size={28} /></span>
      <p className="text-title text-ink">Reply to comments in the list</p>
      <p className="mt-2 max-w-sm text-body text-ink-2">Open a comment to check its private reply, then send it or skip it. Nothing sends until you do.</p>
    </>
  );
}

function PickConversation({ children }: { children?: ReactNode }) {
  return (
    <>
      <span aria-hidden className="mb-5 flex h-16 w-16 items-center justify-center rounded-[20px] bg-surface text-ink-3 shadow-card"><MessagesSquare size={28} /></span>
      <p className="text-title text-ink">Pick a conversation</p>
      <p className="mt-2 max-w-sm text-body text-ink-2">Open a conversation from this view to see its messages and next steps.</p>
      {children}
      <p className="mt-4 max-w-sm text-caption text-ink-3">Press <Kbd keys="j" /> to open the first result, then <Kbd keys="j" /> and <Kbd keys="k" /> to move through this view.</p>
    </>
  );
}

/** On "Needs you", one click opens the biggest conversation in the same creator scope as the list. */
function StartWithBiggest() {
  const params = useSearchParams();
  const { threads } = useApp();
  const account = params?.get("account") ?? null;
  if (inboxView(params?.get("view")) !== "needs" || params?.get("q") || params?.get("stage")) return null;
  const top = threads.filter((thread) => needsYou(thread) && (!account || thread.igAccountId === account)).sort(byValueDesc)[0];
  if (!top) return null;
  return (
    <Link href={conversationHref(top.id, params ?? new URLSearchParams())} className={buttonClasses({ variant: "primary", className: "mt-6 max-w-full" })}>
      <span className="truncate">Start with {displayName(top.participant, top.handle)}</span>
      <ArrowRight aria-hidden size={17} />
    </Link>
  );
}
