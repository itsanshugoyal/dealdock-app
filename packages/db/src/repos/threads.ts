import { Prisma } from "@prisma/client";
import { DomainError, findDealSignal, type DraftContextSummary } from "@dealdock/core";
import { prisma } from "../client";
import type { OrgId } from "../org-id";
import { writeAudit } from "../audit-log";
import { minorUnitsToNumber } from "../money";
import { isNudgeDue } from "../schedule-rules";
import { messageBody, participantOf, pickTopClassification, senderLedger } from "../sender-context";

function money(value: bigint | null): number | null {
  return value === null ? null : minorUnitsToNumber(value);
}

/**
 * Thread read model. The v1 fields (participantHandle, messages, currentDraft,
 * closedDeals, sendInFlight…) keep their shape — the drafting worker and the
 * draft route read them — and the redesign fields are additive.
 */
export async function getThreadDetail(orgId: OrgId, threadId: string, now = new Date()) {
  const thread = await prisma.thread.findFirst({
    where: { id: threadId, orgId },
    select: {
      id: true,
      igAccountId: true,
      igThreadId: true,
      participantHandle: true,
      participantIgId: true,
      participantName: true,
      participantAvatarUrl: true,
      participantFollowerCount: true,
      participantVerified: true,
      participantFollowsYou: true,
      profileFetchedAt: true,
      source: true,
      state: true,
      lastInboundAt: true,
      lastOutboundAt: true,
      waitingSince: true,
      nudgeDismissedAt: true,
      topLabel: true,
      estValueMaxMinor: true,
      estCurrencyCode: true,
      igAccount: { select: { org: { select: { nudgeDelayDays: true, currencyCode: true } } } },
      messages: {
        // The id tiebreak matches the inbox row's message window (deal signal).
        orderBy: [{ sentAt: "asc" }, { id: "asc" }],
        // Never the raw webhook/Graph payload, nor the audio bytes: playback
        // goes through the signed /media route.
        select: {
          id: true,
          direction: true,
          contentType: true,
          text: true,
          sentAt: true,
          origin: true,
          audioAssetId: true,
          mediaStatus: true,
          durationMs: true,
          transcript: true,
          transcriptLanguage: true,
          classification: {
            select: {
              id: true,
              label: true,
              confidence: true,
              valueMinMinor: true,
              valueMaxMinor: true,
              rationale: true,
              routedTo: true,
              reviewedAt: true,
              createdAt: true,
            },
          },
          audioAsset: { select: { mimeType: true } },
        },
      },
      drafts: {
        where: { status: { in: ["ready", "edited", "sending"] } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          body: true,
          kind: true,
          status: true,
          version: true,
          label: true,
          instruction: true,
          chips: true,
          alternatives: true,
          chosenAlternative: true,
          generationContext: true,
        },
      },
      ledger: {
        where: { deletedAt: null },
        orderBy: { closedAt: "asc" },
        select: { id: true, amountMinor: true, currencyCode: true, dealType: true, note: true, closedAt: true },
      },
    },
  });
  if (!thread) return null;

  const org = thread.igAccount.org;
  const { totals } = await senderLedger(orgId, [thread]);
  const top = pickTopClassification(thread.messages.flatMap((m) => (m.classification ? [m.classification] : [])));
  const draft = thread.drafts[0];

  return {
    id: thread.id,
    participantHandle: thread.participantHandle,
    participant: participantOf(thread, totals),
    state: thread.state,
    waitingSince: thread.waitingSince,
    nudgeDue: isNudgeDue(thread, org.nudgeDelayDays, now),
    topLabel: thread.topLabel,
    estValueMinMinor: money(top?.valueMinMinor ?? null),
    estValueMaxMinor: money(thread.estValueMaxMinor),
    estCurrencyCode: thread.estCurrencyCode,
    rationale: top?.rationale ?? null,
    lastInboundAt: thread.lastInboundAt,
    source: thread.source,
    igAccountId: thread.igAccountId,
    igThreadRemoteId: thread.igThreadId,
    messages: thread.messages.map((m) => ({
      id: m.id,
      direction: m.direction,
      contentType: m.contentType,
      text: m.text,
      sentAt: m.sentAt,
      origin: m.origin,
      audioAssetId: m.audioAssetId,
      audioMimeType: m.audioAsset?.mimeType ?? null,
      mediaStatus: m.mediaStatus,
      durationMs: m.durationMs,
      transcript: m.transcript,
      transcriptLanguage: m.transcriptLanguage,
      classification: m.classification
        ? {
            id: m.classification.id,
            label: m.classification.label,
            confidence: m.classification.confidence,
            rationale: m.classification.rationale,
            valueMinMinor: money(m.classification.valueMinMinor),
            valueMaxMinor: money(m.classification.valueMaxMinor),
            reviewedAt: m.classification.reviewedAt,
          }
        : null,
    })),
    sendInFlight: draft?.status === "sending",
    currentDraft:
      draft && draft.status !== "sending"
        ? {
            id: draft.id,
            body: draft.body,
            kind: draft.kind,
            status: draft.status,
            version: draft.version,
            label: draft.label,
            instruction: draft.instruction,
            chips: draft.chips,
            alternatives: draft.alternatives,
            chosenAlternative: draft.chosenAlternative,
            generationContext: draft.generationContext,
          }
        : null,
    closedDeals: thread.ledger.map((l) => ({
      id: l.id,
      amountMinor: minorUnitsToNumber(l.amountMinor),
      currencyCode: l.currencyCode,
      dealType: l.dealType,
      note: l.note,
      closedAt: l.closedAt,
    })),
    dealSignal: findDealSignal({
      messages: thread.messages.map((m) => ({ id: m.id, direction: m.direction, text: messageBody(m), sentAt: m.sentAt })),
      state: thread.state,
      label: thread.topLabel,
      currencyCode: org.currencyCode,
      recordedAt: thread.ledger.map((l) => l.closedAt),
    }),
  };
}

const MAX_CONTEXT_ITEMS = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, MAX_CONTEXT_ITEMS)
    : [];
}

function records<T>(value: unknown, pick: (item: Record<string, unknown>) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const picked = isRecord(item) ? pick(item) : null;
    return picked === null ? [] : [picked];
  }).slice(0, MAX_CONTEXT_ITEMS);
}

/** Rows fetched by id, back in the order the generation used them. */
function inOrder<T>(ids: string[], rows: T[], idOf: (row: T) => string): T[] {
  const byId = new Map(rows.map((row) => [idOf(row), row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

/**
 * "Why this draft" (DraftDto.context) from Draft.generationContext. Accepts
 * the resolved summary ({rules, exemplars, offers, lessons, missingFacts}) or
 * the id form documented on the schema ({ruleIds, exemplarMessageIds,
 * offerIds}), resolving ids inside this org only. Null for drafts generated
 * before context was recorded.
 */
export async function resolveDraftContext(orgId: OrgId, generationContext: unknown): Promise<DraftContextSummary | null> {
  if (!isRecord(generationContext)) return null;
  const ctx = generationContext;
  const keys = ["rules", "exemplars", "offers", "lessons", "missingFacts", "ruleIds", "exemplarMessageIds", "offerIds"];
  if (!keys.some((key) => key in ctx)) return null;

  const rules = records(ctx.rules, (o) => (typeof o.id === "string" && typeof o.text === "string" ? { id: o.id, text: o.text } : null));
  const exemplars = records(ctx.exemplars, (o) =>
    typeof o.messageId === "string" && typeof o.text === "string"
      ? { messageId: o.messageId, text: o.text, inboundText: typeof o.inboundText === "string" ? o.inboundText : null }
      : null,
  );
  const offers = records(ctx.offers, (o) => (typeof o.id === "string" && typeof o.name === "string" ? { id: o.id, name: o.name } : null));
  const ruleIds = strings(ctx.ruleIds).filter((id) => !rules.some((rule) => rule.id === id));
  const exemplarIds = strings(ctx.exemplarMessageIds).filter((id) => !exemplars.some((exemplar) => exemplar.messageId === id));
  const offerIds = strings(ctx.offerIds).filter((id) => !offers.some((offer) => offer.id === id));

  const [ruleRows, exemplarRows, offerRows] = await Promise.all([
    ruleIds.length ? prisma.voiceRule.findMany({ where: { orgId, id: { in: ruleIds } }, select: { id: true, text: true } }) : [],
    exemplarIds.length
      ? prisma.$queryRaw<Array<{ messageId: string; text: string; inboundText: string | null }>>`
          SELECT e."id" AS "messageId", e."text",
            (SELECT i."text" FROM "Message" i
              WHERE i."orgId" = e."orgId" AND i."threadId" = e."threadId" AND i."direction" = 'inbound' AND i."sentAt" <= e."sentAt"
              ORDER BY i."sentAt" DESC, i."id" DESC LIMIT 1) AS "inboundText"
          FROM "Message" e
          WHERE e."orgId" = ${orgId} AND e."id" IN (${Prisma.join(exemplarIds)})`
      : [],
    offerIds.length ? prisma.offer.findMany({ where: { orgId, id: { in: offerIds } }, select: { id: true, name: true } }) : [],
  ]);

  return {
    rules: [...rules, ...inOrder(ruleIds, ruleRows, (row) => row.id)],
    exemplars: [...exemplars, ...inOrder(exemplarIds, exemplarRows, (row) => row.messageId)],
    offers: [...offers, ...inOrder(offerIds, offerRows, (row) => row.id)],
    lessons: strings(ctx.lessons),
    missingFacts: strings(ctx.missingFacts),
  };
}

/**
 * "Not now" on a due follow-up (PRD §5.3/§6.5): the thread stays waiting, its
 * nudge clock restarts (the follow-up returns after another nudgeDelayDays of
 * silence), and the drafted nudge is discarded. The restart replaces the old
 * forever-suppression marker, so nudgeDismissedAt is cleared.
 */
export async function dismissNudge(orgId: OrgId, threadId: string, seatId: string) {
  return prisma.$transaction(async (tx) => {
    const thread = await tx.thread.findFirst({
      where: { id: threadId, orgId },
      select: { id: true, state: true },
    });
    if (!thread) throw new DomainError("thread not in org", 404);

    if (thread.state === "waiting") {
      await tx.thread.update({
        where: { id: thread.id },
        data: { waitingSince: new Date(), nudgeDismissedAt: null },
      });
    }
    await tx.draft.updateMany({
      where: { orgId, threadId, kind: "nudge", status: { in: ["ready", "edited"] } },
      data: { status: "discarded" },
    });
    await writeAudit(tx, {
      orgId,
      seatId,
      action: "nudge.dismissed",
      entityType: "thread",
      entityId: thread.id,
    });
  });
}

/**
 * Whether the sender wrote again after `sentAt` (a message in the same thread
 * sent strictly later), e.g. so a reply or nudge drafted against an older
 * message can be recognised as stale.
 */
export async function hasNewerInbound(orgId: OrgId, threadId: string, sentAt: Date): Promise<boolean> {
  const newer = await prisma.message.findFirst({
    where: { orgId, threadId, direction: "inbound", sentAt: { gt: sentAt } },
    select: { id: true },
  });
  return newer !== null;
}

/** Thread state machine: open ↔ waiting → closed. Waiting starts the nudge clock (PRD §6.5). */
export async function setThreadState(
  orgId: OrgId,
  input: { threadId: string; seatId: string; state: "open" | "waiting" | "closed" }
) {
  return prisma.$transaction(async (tx) => {
    const thread = await tx.thread.findFirst({
      where: { id: input.threadId, orgId },
      select: { id: true, state: true },
    });
    if (!thread) throw new DomainError("thread not in org", 404);

    const updated = await tx.thread.update({
      where: { id: thread.id },
      data: {
        state: input.state,
        waitingSince: input.state === "waiting" ? new Date() : null,
        ...(input.state !== "waiting" ? { nudgeDismissedAt: null } : {}),
      },
    });

    await writeAudit(tx, {
      orgId,
      seatId: input.seatId,
      action: "thread.state_changed",
      entityType: "thread",
      entityId: thread.id,
      detail: { from: thread.state, to: input.state },
    });

    return updated;
  });
}
