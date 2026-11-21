import type { CommentLead } from "@prisma/client";
import { COMMENT_REPLY_WINDOW_MS, commentReplyBy, DomainError, normalizeCommentKeywords, type CommentLeadDto } from "@dealdock/core";
import { prisma } from "../client";
import type { OrgId } from "../org-id";
import { writeAudit } from "../audit-log";
import { requireSeatInOrg } from "../seat-scope";

/**
 * Comment leads: a keyword comment on a creator's post, and the one private
 * reply Instagram allows for it (within 7 days of the comment). The worker
 * creates and drafts leads; only the API's send route, after a person
 * approves, moves one to sent.
 */

/** The ingestion outbox kind for a keyword comment (payload: CommentLeadInput, dates as ISO strings). */
export const COMMENT_LEAD_OUTBOX_KIND = "comment_lead";
/** A send that died mid-flight (a crashed process) frees its lead after this; Instagram itself refuses a second reply to one comment. */
const STALE_SEND_MS = 5 * 60_000;
const MAX_DRAFT = 2_000;

export interface CommentLeadInput {
  igAccountId: string;
  commentId: string;
  mediaId: string;
  commenterIgId: string;
  commenterHandle: string;
  text: string;
  keyword: string;
  commentedAt: Date;
}

export function toCommentLeadDto(row: Pick<CommentLead, "id" | "igAccountId" | "commenterHandle" | "text" | "keyword" | "mediaUrl" | "commentedAt" | "status" | "draftBody" | "missingFacts" | "sentAt">): CommentLeadDto {
  return {
    id: row.id,
    igAccountId: row.igAccountId,
    commenterHandle: row.commenterHandle,
    text: row.text,
    keyword: row.keyword,
    mediaUrl: row.mediaUrl,
    commentedAt: row.commentedAt.toISOString(),
    replyBy: commentReplyBy(row.commentedAt).toISOString(),
    status: row.status,
    draftBody: row.draftBody,
    missingFacts: row.missingFacts,
    sentAt: row.sentAt?.toISOString() ?? null,
  };
}

const LEAD_FIELDS = {
  id: true, igAccountId: true, commentId: true, mediaId: true, commenterHandle: true, text: true, keyword: true,
  mediaUrl: true, commentedAt: true, status: true, draftBody: true, missingFacts: true, sentAt: true,
} as const;

/** SYSTEM context for the webhook: the active Instagram account a comment names, with its keywords. */
export async function findCommentLeadAccount(igUserId: string) {
  return prisma.igAccount.findFirst({
    where: { platform: "instagram", igUserId, status: "active" },
    select: { id: true, orgId: true, handle: true, igUserId: true, commentKeywords: true },
  });
}

/** Redis carries a reference; the comment itself stays in its tenant's outbox row. */
export async function getCommentLeadOutboxPayload(orgId: OrgId, eventId: string) {
  const row = await prisma.outboxEvent.findFirst({ where: { id: eventId, orgId, kind: COMMENT_LEAD_OUTBOX_KIND }, select: { payload: true } });
  return row?.payload ?? null;
}

/**
 * The lead for one keyword comment, created once per comment (Meta
 * redelivers). Nothing is created for a disconnected account, for someone on
 * the creator's People to skip list, or once the comment's 7 days are over.
 */
export async function createCommentLead(orgId: OrgId, input: CommentLeadInput, now = new Date()) {
  if (now.getTime() - input.commentedAt.getTime() >= COMMENT_REPLY_WINDOW_MS) return { skipped: "too_late" as const };
  return prisma.$transaction(async (tx) => {
    const account = await tx.igAccount.findFirst({ where: { id: input.igAccountId, orgId, platform: "instagram" }, select: { status: true } });
    if (!account) throw new DomainError("ig_account_not_in_org", 404);
    if (account.status !== "active") return { skipped: "account_inactive" as const };
    const handle = input.commenterHandle.replace(/^@/, "").toLowerCase();
    const ignored = await tx.ignoreListEntry.findFirst({
      where: { orgId, handle, OR: [{ igAccountId: input.igAccountId }, { igAccountId: null }] },
      select: { id: true },
    });
    if (ignored) return { skipped: "ignored" as const };
    const lead = await tx.commentLead.upsert({
      where: { igAccountId_commentId: { igAccountId: input.igAccountId, commentId: input.commentId } },
      create: { orgId, ...input },
      update: {},
      select: { id: true, orgId: true, status: true, draftBody: true },
    });
    if (lead.orgId !== orgId) throw new Error("comment_lead_cross_org_collision");
    return { id: lead.id, status: lead.status, draftBody: lead.draftBody };
  });
}

/** One lead with what drafting and sending need. */
export async function getCommentLead(orgId: OrgId, leadId: string) {
  return prisma.commentLead.findFirst({ where: { id: leadId, orgId }, select: LEAD_FIELDS });
}

/** A (new) draft lands only on a lead still waiting for its reply: never one being sent or already sent. */
export async function saveCommentLeadDraft(orgId: OrgId, leadId: string, draft: { body: string; modelVersion: string; missingFacts: string[] }) {
  const { count } = await prisma.commentLead.updateMany({
    where: { id: leadId, orgId, status: "new" },
    data: { draftBody: draft.body.slice(0, MAX_DRAFT), modelVersion: draft.modelVersion, missingFacts: draft.missingFacts.slice(0, 3) },
  });
  return count === 1;
}

/** Leads to show, newest first: all but skipped ones; one creator's when asked. Includes mediaId for the API's post-link lookup. */
export async function listCommentLeads(orgId: OrgId, igAccountId?: string, limit = 200) {
  return prisma.commentLead.findMany({
    where: { orgId, status: { not: "skipped" }, ...(igAccountId ? { igAccountId } : {}) },
    orderBy: [{ commentedAt: "desc" }, { id: "desc" }],
    take: limit,
    select: LEAD_FIELDS,
  });
}

/** Each Instagram account's keywords (email inboxes have none). */
export async function listCommentKeywords(orgId: OrgId) {
  const accounts = await prisma.igAccount.findMany({
    where: { orgId, platform: "instagram" },
    orderBy: [{ connectedAt: "asc" }, { id: "asc" }],
    select: { id: true, commentKeywords: true },
  });
  return accounts.map((account) => ({ igAccountId: account.id, keywords: account.commentKeywords }));
}

/** Replaces one creator's keywords (core normalizeCommentKeywords: trimmed, ≤ 10, 1–30 characters). */
export async function setCommentKeywords(orgId: OrgId, seatId: string, igAccountId: string, keywords: readonly string[]) {
  const result = normalizeCommentKeywords(keywords);
  if (!result.ok) throw new DomainError(result.error, 400);
  return prisma.$transaction(async (tx) => {
    await requireSeatInOrg(orgId, seatId, tx);
    const account = await tx.igAccount.findFirst({ where: { id: igAccountId, orgId, platform: "instagram" }, select: { id: true } });
    if (!account) throw new DomainError("ig_account_not_in_org", 404);
    await tx.igAccount.update({ where: { id: account.id }, data: { commentKeywords: result.keywords } });
    await writeAudit(tx, {
      orgId, seatId, action: "settings.comment_keywords_changed", entityType: "ig_account", entityId: account.id,
      detail: { count: result.keywords.length },
    });
    return result.keywords;
  });
}

export type CommentLeadClaim =
  | { claimed: true; lead: { id: string; igAccountId: string; commentId: string; commenterHandle: string; draftBody: string | null } }
  | { claimed: false; reason: "not_found" | "too_late" | "sending" | "sent" | "skipped" };

/**
 * Moves one lead new → sending in a single conditional UPDATE, so exactly one
 * reply can go per comment, and never after its 7 days. A lead left
 * "sending" by a crashed process is claimable again after 5 minutes. The
 * sender's seat is checked here, before anything reaches Instagram.
 */
export async function claimCommentLeadSend(orgId: OrgId, leadId: string, seatId: string, now = new Date()): Promise<CommentLeadClaim> {
  await requireSeatInOrg(orgId, seatId);
  const [lead] = await prisma.commentLead.updateManyAndReturn({
    where: {
      id: leadId,
      orgId,
      commentedAt: { gt: new Date(now.getTime() - COMMENT_REPLY_WINDOW_MS) },
      OR: [{ status: "new" }, { status: "sending", updatedAt: { lt: new Date(now.getTime() - STALE_SEND_MS) } }],
    },
    data: { status: "sending" },
    select: { id: true, igAccountId: true, commentId: true, commenterHandle: true, draftBody: true },
  });
  if (lead) return { claimed: true, lead };
  const current = await prisma.commentLead.findFirst({ where: { id: leadId, orgId }, select: { status: true, commentedAt: true } });
  if (!current) return { claimed: false, reason: "not_found" };
  if (current.status === "sent" || current.status === "skipped") return { claimed: false, reason: current.status };
  return { claimed: false, reason: now.getTime() - current.commentedAt.getTime() >= COMMENT_REPLY_WINDOW_MS ? "too_late" : "sending" };
}

/** The reply went (the seat was checked at the claim): who sent it, the words that went, and the audit row, together. */
export async function completeCommentLeadSend(orgId: OrgId, leadId: string, input: { seatId: string; text: string; sentAt: Date }) {
  return prisma.$transaction(async (tx) => {
    const lead = await tx.commentLead.findFirst({ where: { id: leadId, orgId, status: "sending" }, select: { igAccountId: true, keyword: true, draftBody: true } });
    if (!lead) throw new DomainError("comment_lead_not_sending", 409);
    const sent = await tx.commentLead.update({
      where: { id: leadId },
      data: { status: "sent", sentAt: input.sentAt, sentBySeatId: input.seatId, draftBody: input.text, missingFacts: [] },
      select: LEAD_FIELDS,
    });
    await writeAudit(tx, {
      orgId, seatId: input.seatId, action: "comment_lead.sent", entityType: "comment_lead", entityId: leadId,
      detail: { igAccountId: lead.igAccountId, keyword: lead.keyword, edited: lead.draftBody !== input.text },
    });
    return sent;
  });
}

/** The send failed before Instagram took it: the lead is the creator's to try again, or skip. */
export async function releaseCommentLeadSend(orgId: OrgId, leadId: string) {
  await prisma.commentLead.updateMany({ where: { id: leadId, orgId, status: "sending" }, data: { status: "new" } });
}

/** "Skip": no private reply for this comment. Only a lead still waiting for its reply can be skipped. */
export async function skipCommentLead(orgId: OrgId, seatId: string, leadId: string) {
  return prisma.$transaction(async (tx) => {
    await requireSeatInOrg(orgId, seatId, tx);
    const { count } = await tx.commentLead.updateMany({ where: { id: leadId, orgId, status: "new" }, data: { status: "skipped" } });
    if (count === 0) {
      const lead = await tx.commentLead.findFirst({ where: { id: leadId, orgId }, select: { id: true } });
      throw lead ? new DomainError("comment_lead_not_open", 409) : new DomainError("not_found", 404);
    }
    await writeAudit(tx, { orgId, seatId, action: "comment_lead.skipped", entityType: "comment_lead", entityId: leadId });
  });
}

/**
 * Deletes leads whose 7 days ran out without a reply (and skipped ones past
 * them): they can't be answered privately any more. One creator's when asked.
 */
export async function clearExpiredCommentLeads(orgId: OrgId, seatId: string, igAccountId?: string, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    await requireSeatInOrg(orgId, seatId, tx);
    const { count } = await tx.commentLead.deleteMany({
      where: {
        orgId,
        ...(igAccountId ? { igAccountId } : {}),
        status: { in: ["new", "skipped"] },
        commentedAt: { lte: new Date(now.getTime() - COMMENT_REPLY_WINDOW_MS) },
      },
    });
    if (count > 0) {
      await writeAudit(tx, { orgId, seatId, action: "comment_lead.cleared", entityType: "organization", entityId: igAccountId ?? orgId, detail: { count, igAccountId: igAccountId ?? null } });
    }
    return count;
  });
}

/** The post's link, saved once the API has read it from Instagram. */
export async function cacheCommentLeadMediaUrl(orgId: OrgId, igAccountId: string, mediaId: string, mediaUrl: string) {
  await prisma.commentLead.updateMany({ where: { orgId, igAccountId, mediaId, mediaUrl: null }, data: { mediaUrl } });
}
