"use client";

import { useState } from "react";
import type { MessageSource, ParticipantProfile } from "@dealdock/core";
import { UserCheck } from "lucide-react";
import { agoText, compactCount, displayName, formatDate, pluralize } from "../../lib/format";
import { useMinuteClock } from "../../lib/keyboard";
import { useMoneyContext } from "../../lib/use-demo";
import { cx } from "./cx";
import { MoneyValue } from "./money-value";

export type AvatarSize = 20 | 24 | 28 | 32 | 36 | 40 | 44 | 48 | 52 | 56 | 64 | 72 | 88;
export type AvatarRing = "urgent" | "soon" | "money" | "none";

/** Warm, saturated pairs that read as people, not as status colours. */
const GRADIENTS: Array<[string, string]> = [
  ["#FF9A62", "#FF4E7A"],
  ["#7F8CFF", "#5B4FD6"],
  ["#3CD7A4", "#0F8FD6"],
  ["#FFC145", "#FF6A3D"],
  ["#B58BFF", "#E2489B"],
  ["#2CC8E0", "#4F63E8"],
  ["#FF7FB0", "#FF9248"],
  ["#5BDB8A", "#12936A"],
  ["#F7A35C", "#C2416B"],
  ["#68B5FF", "#2B4FD8"],
];

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return Math.abs(h);
}

function initials(handle: string, name?: string | null): string {
  const source = (name?.trim() || handle.replace(/^@/, "")).replace(/[._-]+/g, " ").trim();
  const words = source.split(/\s+/).filter(Boolean);
  const first = words[0]?.charAt(0) ?? "?";
  const second = words.length > 1 ? words[1]!.charAt(0) : "";
  return (first + second).toUpperCase();
}

const RING: Record<Exclude<AvatarRing, "none">, string> = {
  urgent: "var(--dd-danger)",
  soon: "var(--dd-waiting)",
  money: "var(--dd-brand)",
};

/**
 * Avatar: the sender's Instagram photo when we have it, otherwise a gradient
 * monogram keyed to the handle (stable across sessions). `ring` draws the
 * story-style ring that marks a conversation waiting on the creator.
 * Decorative: the name always sits beside it.
 */
export function Avatar({ handle, name, src, size = 40, ring = "none", verified = false, className }: {
  handle: string;
  name?: string | null;
  src?: string | null;
  size?: AvatarSize;
  ring?: AvatarRing;
  verified?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [from, to] = GRADIENTS[hash(handle.toLowerCase()) % GRADIENTS.length]!;
  const text = initials(handle, name);
  const ringColor = ring === "none" ? null : RING[ring];
  const badge = Math.max(14, Math.round(size * 0.34));
  return (
    <span aria-hidden className={cx("relative inline-flex shrink-0", className)} style={{ width: size, height: size }}>
      <span
        className="inline-flex h-full w-full select-none items-center justify-center overflow-hidden rounded-full font-semibold text-white"
        style={{
          background: `linear-gradient(140deg, ${from}, ${to})`,
          fontSize: Math.max(9, Math.round(size * (text.length > 1 ? 0.36 : 0.42))),
          letterSpacing: "-0.02em",
          boxShadow: ringColor ? `0 0 0 2px var(--dd-surface), 0 0 0 4px ${ringColor}` : "inset 0 0 0 0.5px rgba(0,0,0,0.08)",
        }}
      >
        {src && !failed
          // eslint-disable-next-line @next/next/no-img-element -- remote IG avatars; fixed size, lazy, no referrer
          ? <img src={src} alt="" width={size} height={size} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="h-full w-full object-cover" />
          : text}
      </span>
      {verified && <VerifiedBadge size={badge} className="absolute -bottom-0.5 -right-0.5" />}
    </span>
  );
}

/** The blue scalloped check, drawn so it never depends on an icon font. */
export function VerifiedBadge({ size = 14, className, title }: { size?: number; className?: string; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <path fill="#2E8BFF" stroke="var(--dd-surface)" strokeWidth="1.6" d="M12 1.8l2.4 1.7 2.9-.2 1 2.7 2.4 1.6-.6 2.9 1.2 2.6-1.9 2.2-.1 2.9-2.8.8-1.7 2.4-2.8-.8-2.8.8-1.7-2.4-2.8-.8-.1-2.9L2.7 12.2l1.2-2.6-.6-2.9 2.4-1.6 1-2.7 2.9.2z" />
      <path d="M8 12.3l2.6 2.6L16.2 9.3" fill="none" stroke="#fff" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const SOURCE_TEXT: Record<MessageSource, string> = { dm: "Direct message", story: "Story reply", reel: "Reel share", ad: "Ad reply", link: "Link in bio" };
export function sourceText(source: MessageSource | null | undefined): string | null {
  return source ? SOURCE_TEXT[source] ?? null : null;
}

/**
 * Read-only sender context — never a contact record. `compact` for headers
 * (pass `titleAs="h1"` on the thread screen: the handle is the page's only
 * h1); `full` for the deal-facts panel or a sheet.
 */
export function SenderCard({ participant, variant = "compact", source, firstMessageAt, titleAs: Title = "p", className }: {
  participant: ParticipantProfile;
  variant?: "compact" | "full";
  source?: MessageSource | null;
  firstMessageAt?: number | null;
  titleAs?: "h1" | "h2" | "h3" | "p";
  className?: string;
}) {
  const { timezone, locale } = useMoneyContext();
  const now = useMinuteClock();
  const display = displayName(participant, participant.handle);
  return (
    <div className={cx("flex min-w-0 gap-3", variant === "full" ? "flex-col items-center text-center" : "items-center", className)}>
      <Avatar handle={participant.handle} name={participant.name} src={participant.avatarUrl} size={variant === "full" ? 72 : 40} verified={Boolean(participant.verified)} />
      <div className={cx("min-w-0", variant === "full" && "flex flex-col items-center")}>
        <Title className={cx("truncate text-ink", variant === "full" ? "text-title" : "text-heading")}><bdi>{display}</bdi></Title>
        <p className="flex flex-wrap items-center gap-x-1.5 truncate text-caption text-ink-3">
          {participant.name?.trim() && <bdi>@{participant.handle}</bdi>}
          {participant.followerCount !== null && <span>· {compactCount(participant.followerCount, locale)} followers</span>}
        </p>
      </div>
      {variant === "full" && (
        <dl className="grid w-full gap-px overflow-hidden rounded-2xl bg-hairline text-left text-body">
          <Fact term="Follows you" value={participant.followsYou ? <span className="inline-flex items-center gap-1 text-ink"><UserCheck aria-hidden size={16} className="text-brand" />Yes</span> : "No"} />
          {sourceText(source) && <Fact term="Came from" value={sourceText(source)} />}
          {firstMessageAt ? <Fact term="First message" value={formatDate(firstMessageAt, locale, timezone)} /> : null}
          <Fact
            term="Sales with you"
            value={participant.closedDeals > 0
              ? <span><MoneyValue minor={participant.closedTotalMinor} mode="exact" kind="confirmed" className="font-semibold" /> · {participant.closedDeals} {pluralize(participant.closedDeals, "sale")}</span>
              : "None yet"}
          />
          {participant.fetchedAt && now > 0 && <Fact term="Profile" value={`Updated ${agoText(Date.parse(participant.fetchedAt), now, locale, timezone)}`} />}
        </dl>
      )}
    </div>
  );
}

function Fact({ term, value }: { term: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 bg-surface px-4 py-3">
      <dt className="text-ink-2">{term}</dt>
      <dd className="text-right text-ink">{value}</dd>
    </div>
  );
}
