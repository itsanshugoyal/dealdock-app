import { createHash } from "node:crypto";
import type { LeadEventKind, LeadStage, Prisma } from "@prisma/client";
import {
  DomainError,
  LEAD_STAGES,
  forwardStage,
  threadIdFromRef,
  type LeadEventDto,
  type LeadSourceDto,
  type LeadSourceProvider,
  type LeadSourcesResponse,
  type ParsedLeadEvent,
} from "@dealdock/core";
import { prisma } from "../client";
import { asOrgId, type OrgId } from "../org-id";
import { writeAudit } from "../audit-log";
import { requireSeatInOrg } from "../seat-scope";
import { decryptToken, encryptToken } from "../crypto";
import { minorUnitsToNumber } from "../money";

/**
 * Booking and payment tools that report back to the coach pipeline. Each
 * source is a webhook address whose secret segment (a token shown once) is
 * stored only as its SHA-256; a tool's signing secret is AES-256-GCM like
 * account tokens and decrypted only for the API's signature check. A
 * reported booking or payment moves its conversation's stage forward.
 */

const SOURCE_SELECT = { id: true, provider: true, label: true, lastEventAt: true, createdAt: true, secretEnc: true } satisfies Prisma.LeadSourceSelect;
/** Tools whose reports are signed with a secret the creator pastes in: until it is saved, nothing they send is accepted. */
const SIGNED: ReadonlySet<LeadSourceProvider> = new Set(["razorpay", "stripe"]);
const EVENT_SELECT = {
  id: true,
  sourceId: true,
  kind: true,
  threadId: true,
  amountMinor: true,
  currencyCode: true,
  payerName: true,
  occurredAt: true,
  source: { select: { provider: true } },
} satisfies Prisma.LeadEventSelect;

function toSourceDto(row: Prisma.LeadSourceGetPayload<{ select: typeof SOURCE_SELECT }>): LeadSourceDto {
  // The secret itself never leaves this module: only whether one is missing.
  return { id: row.id, provider: row.provider, label: row.label, lastEventAt: row.lastEventAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), needsSecret: SIGNED.has(row.provider) && row.secretEnc === null };
}

export function toLeadEventDto(row: Prisma.LeadEventGetPayload<{ select: typeof EVENT_SELECT }>): LeadEventDto {
  return {
    id: row.id,
    sourceId: row.sourceId,
    provider: row.source.provider,
    kind: row.kind,
    threadId: row.threadId,
    amountMinor: row.amountMinor === null ? null : minorUnitsToNumber(row.amountMinor),
    currencyCode: row.currencyCode,
    payerName: row.payerName,
    occurredAt: row.occurredAt.toISOString(),
  };
}

/** The stored form of a webhook address's secret segment. */
export function hashLeadToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The connected tools, and what they reported that matched no conversation (newest first, still to match or dismiss). */
export async function listLeadSources(orgId: OrgId): Promise<LeadSourcesResponse> {
  const [sources, unmatched] = await Promise.all([
    prisma.leadSource.findMany({ where: { orgId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: SOURCE_SELECT }),
    prisma.leadEvent.findMany({ where: { orgId, threadId: null, handledAt: null }, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 50, select: EVENT_SELECT }),
  ]);
  return { sources: sources.map(toSourceDto), unmatched: unmatched.map(toLeadEventDto) };
}

/**
 * Connect a tool. `token` is the caller's 32+ random bytes (base64url) for the
 * address, kept only as its hash; `secret` the tool's signing secret, if it has one.
 */
export async function createLeadSource(
  orgId: OrgId,
  seatId: string,
  input: { provider: LeadSourceProvider; label: string | null; token: string; secret: string | null },
): Promise<LeadSourceDto> {
  await requireSeatInOrg(orgId, seatId);
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(input.token)) throw new DomainError("invalid_lead_token", 400);
  return prisma.$transaction(async (tx) => {
    const source = await tx.leadSource.create({
      data: { orgId, provider: input.provider, label: input.label, tokenHash: hashLeadToken(input.token), secretEnc: input.secret ? encryptToken(input.secret) : null },
      select: SOURCE_SELECT,
    });
    await writeAudit(tx, { orgId, seatId, action: "lead_source.connected", entityType: "lead_source", entityId: source.id, detail: { provider: input.provider } });
    return toSourceDto(source);
  });
}

/** Save (or replace) a tool's signing secret: Stripe shows it only once the address is saved there. */
export async function setLeadSourceSecret(orgId: OrgId, seatId: string, sourceId: string, secret: string): Promise<LeadSourceDto> {
  await requireSeatInOrg(orgId, seatId);
  const source = await prisma.leadSource.findFirst({ where: { id: sourceId, orgId }, select: { id: true, provider: true } });
  if (!source) throw new DomainError("lead source not in org", 404);
  if (source.provider === "calendly" || source.provider === "other") throw new DomainError("lead_source_takes_no_secret", 409);
  return toSourceDto(await prisma.leadSource.update({ where: { id: source.id }, data: { secretEnc: encryptToken(secret) }, select: SOURCE_SELECT }));
}

/** Remove a tool: its address stops working at once, and what it reported goes with it. */
export async function deleteLeadSource(orgId: OrgId, seatId: string, sourceId: string): Promise<void> {
  await requireSeatInOrg(orgId, seatId);
  await prisma.$transaction(async (tx) => {
    const source = await tx.leadSource.findFirst({ where: { id: sourceId, orgId }, select: { id: true, provider: true } });
    if (!source) throw new DomainError("lead source not in org", 404);
    await tx.leadSource.delete({ where: { id: source.id } });
    await writeAudit(tx, { orgId, seatId, action: "lead_source.removed", entityType: "lead_source", entityId: source.id, detail: { provider: source.provider } });
  });
}

/**
 * Webhook tenancy: the source a URL token belongs to, with its signing secret
 * decrypted for the API's signature check. Not org-scoped: the token is what
 * names the org. Null for anything that isn't a live token.
 */
export async function resolveLeadSource(token: string) {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) return null;
  const source = await prisma.leadSource.findUnique({
    where: { tokenHash: hashLeadToken(token) },
    select: { id: true, orgId: true, provider: true, secretEnc: true, org: { select: { currencyCode: true } } },
  });
  if (!source) return null;
  return { id: source.id, orgId: asOrgId(source.orgId), provider: source.provider, secret: source.secretEnc ? decryptToken(source.secretEnc) : null, orgCurrency: source.org.currencyCode };
}

/** Stages before `next`: an automatic move may only come from one of these (or no stage). */
function before(next: LeadStage): LeadStage[] {
  return LEAD_STAGES.slice(0, LEAD_STAGES.indexOf(next)) as LeadStage[];
}

/**
 * A booking or payment moves its conversation to booked or paid, never back:
 * the condition is in the write, so two reports racing can't undo each other.
 */
async function moveForward(tx: Prisma.TransactionClient, orgId: OrgId, threadId: string, kind: LeadEventKind, by: Record<string, string>, seatId: string | null = null) {
  const thread = await tx.thread.findFirst({ where: { id: threadId, orgId }, select: { leadStage: true } });
  const next = thread ? forwardStage(thread.leadStage, kind) : null;
  if (!thread || !next) return;
  const moved = await tx.thread.updateMany({
    where: { id: threadId, orgId, OR: [{ leadStage: null }, { leadStage: { in: before(next) } }] },
    data: { leadStage: next, leadStageAt: new Date() },
  });
  if (moved.count) await writeAudit(tx, { orgId, seatId, action: "thread.lead_stage_changed", entityType: "thread", entityId: threadId, detail: { from: thread.leadStage, to: next, ...by } });
}

/**
 * The conversation an event belongs to: the one its tagged link named, if it
 * is this org's; else the one participant whose display name is exactly the
 * payer's (any case); else none.
 */
async function matchThread(orgId: OrgId, event: ParsedLeadEvent): Promise<{ id: string; handle: string } | null> {
  const referenced = threadIdFromRef(event.ref);
  if (referenced) {
    const thread = await prisma.thread.findFirst({ where: { id: referenced, orgId }, select: { id: true, participantHandle: true } });
    if (thread) return { id: thread.id, handle: thread.participantHandle };
  }
  if (!event.payerName) return null;
  const named = await prisma.thread.findMany({
    where: { orgId, participantName: { equals: event.payerName, mode: "insensitive" } },
    select: { id: true, participantHandle: true },
    take: 2,
  });
  return named.length === 1 ? { id: named[0]!.id, handle: named[0]!.participantHandle } : null;
}

/**
 * Store what a tool reported, once per (source, its id): a redelivery changes
 * nothing. Each new event is matched to a conversation and moves its stage
 * forward. Returns the new payments that matched, for a push notification.
 */
export async function recordLeadEvents(orgId: OrgId, source: { id: string; provider: LeadSourceProvider }, events: readonly ParsedLeadEvent[]) {
  const matchedPayments: Array<{ threadId: string; handle: string; amountMinor: number | null; currencyCode: string | null }> = [];
  let stored = 0;
  for (const event of events) {
    const thread = await matchThread(orgId, event);
    const created = await prisma.$transaction(async (tx) => {
      const inserted = await tx.leadEvent.createMany({
        data: [{
          orgId,
          sourceId: source.id,
          externalId: event.externalId,
          kind: event.kind,
          threadId: thread?.id ?? null,
          amountMinor: event.amountMinor === null ? null : BigInt(event.amountMinor),
          currencyCode: event.amountMinor === null ? null : event.currencyCode,
          payerName: event.payerName,
          occurredAt: new Date(event.occurredAt),
        }],
        skipDuplicates: true,
      });
      if (inserted.count && thread) await moveForward(tx, orgId, thread.id, event.kind, { by: source.provider });
      return inserted.count > 0;
    });
    if (!created) continue;
    stored += 1;
    if (thread && event.kind === "paid") matchedPayments.push({ threadId: thread.id, handle: thread.handle, amountMinor: event.amountMinor, currencyCode: event.currencyCode });
  }
  await prisma.leadSource.update({ where: { id: source.id }, data: { lastEventAt: new Date() } });
  return { stored, duplicates: events.length - stored, matchedPayments };
}

/** Payments reported for a conversation that aren't recorded or dismissed yet, newest first. */
export async function listLeadPayments(orgId: OrgId, threadId: string): Promise<LeadEventDto[]> {
  const rows = await prisma.leadEvent.findMany({
    where: { orgId, threadId, kind: "paid", handledAt: null },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: 5,
    select: EVENT_SELECT,
  });
  return rows.map(toLeadEventDto);
}

/** The creator puts an unmatched booking or payment with its conversation; the stage moves forward as a report would move it. */
export async function matchLeadEvent(orgId: OrgId, seatId: string, eventId: string, threadId: string): Promise<LeadEventDto> {
  await requireSeatInOrg(orgId, seatId);
  return prisma.$transaction(async (tx) => {
    const [event, thread] = await Promise.all([
      tx.leadEvent.findFirst({ where: { id: eventId, orgId }, select: { id: true, threadId: true, handledAt: true, kind: true, source: { select: { provider: true } } } }),
      tx.thread.findFirst({ where: { id: threadId, orgId }, select: { id: true } }),
    ]);
    if (!event || !thread) throw new DomainError("lead event or thread not in org", 404);
    if (event.handledAt) throw new DomainError("lead_event_handled", 409);
    if (event.threadId !== null && event.threadId !== thread.id) throw new DomainError("lead_event_already_matched", 409);
    const matched = await tx.leadEvent.update({ where: { id: event.id }, data: { threadId: thread.id }, select: EVENT_SELECT });
    if (event.threadId === null) {
      await moveForward(tx, orgId, thread.id, event.kind, { by: event.source.provider }, seatId);
      await writeAudit(tx, { orgId, seatId, action: "lead_event.matched", entityType: "lead_event", entityId: event.id, detail: { threadId: thread.id } });
    }
    return toLeadEventDto(matched);
  });
}

/** "Dismiss": the payment or booking stops asking to be recorded or matched. Twice is the same as once. */
export async function dismissLeadEvent(orgId: OrgId, seatId: string, eventId: string): Promise<void> {
  await requireSeatInOrg(orgId, seatId);
  await prisma.$transaction(async (tx) => {
    const event = await tx.leadEvent.findFirst({ where: { id: eventId, orgId }, select: { id: true, handledAt: true, threadId: true } });
    if (!event) throw new DomainError("lead event not in org", 404);
    if (event.handledAt) return;
    await tx.leadEvent.update({ where: { id: event.id }, data: { handledAt: new Date() } });
    await writeAudit(tx, { orgId, seatId, action: "lead_event.dismissed", entityType: "lead_event", entityId: event.id, detail: { threadId: event.threadId } });
  });
}

/** The creator sets the stage by hand: any stage, forward or back. */
export async function setLeadStage(orgId: OrgId, seatId: string, threadId: string, stage: LeadStage): Promise<{ leadStage: LeadStage }> {
  await requireSeatInOrg(orgId, seatId);
  return prisma.$transaction(async (tx) => {
    const thread = await tx.thread.findFirst({ where: { id: threadId, orgId }, select: { id: true, leadStage: true } });
    if (!thread) throw new DomainError("thread not in org", 404);
    if (thread.leadStage === stage) return { leadStage: stage };
    await tx.thread.update({ where: { id: thread.id }, data: { leadStage: stage, leadStageAt: new Date() } });
    await writeAudit(tx, { orgId, seatId, action: "thread.lead_stage_changed", entityType: "thread", entityId: thread.id, detail: { from: thread.leadStage, to: stage } });
    return { leadStage: stage };
  });
}
