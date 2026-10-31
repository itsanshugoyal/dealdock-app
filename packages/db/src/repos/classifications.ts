import { DomainError, REVIEW_CONFIDENCE_THRESHOLD } from "@dealdock/core";
import { prisma } from "../client";
import type { Prisma } from "@prisma/client";
import type { OrgId } from "../org-id";
import { writeAudit } from "../audit-log";
import { requireSeatInOrg } from "../seat-scope";
import { pickTopClassification } from "../sender-context";
import { lockThread } from "../thread-writes";

/** Rebuild the inbox denormalization under the thread lock from persisted rows. */
async function refreshThreadClassificationState(
  tx: Prisma.TransactionClient,
  threadId: string,
) {
  const classifications = await tx.classification.findMany({
    where: { message: { threadId } },
    select: { label: true, valueMaxMinor: true, currencyCode: true, routedTo: true, reviewOutcome: true, createdAt: true },
  });
  const pendingReview = classifications.some(
    (row) => row.routedTo === "review_queue" && row.reviewOutcome === null,
  );
  // The same pick the inbox row and thread detail read the estimate back with.
  const top = pickTopClassification(classifications);
  await tx.thread.update({
    where: { id: threadId },
    data: {
      hasPendingReview: pendingReview,
      topLabel: top?.label ?? null,
      estValueMaxMinor: top?.valueMaxMinor ?? null,
      estCurrencyCode: top?.valueMaxMinor === null || !top ? null : top.currencyCode,
    },
  });
}

export interface ClassificationInput {
  messageId: string;
  label:
    | "brand_deal"
    | "coaching_lead"
    | "course_inquiry"
    | "other_commerce"
    | "fan"
    | "spam"
    | "personal"
    | "uncertain";
  confidence: number;
  language: "en" | "hi" | "hinglish" | "mixed";
  valueMinMinor: number | null;
  valueMaxMinor: number | null;
  /** Defaults to the org's current currency for newly-created estimates. */
  currencyCode?: string;
  rationale: string | null;
  modelVersion: string;
  promptVersion: string;
  routedTo: "inbox" | "review_queue";
  source?: "live" | "leak_scan";
}

/**
 * Persists a classification and updates the thread's denormalized sort fields
 * (topLabel + estValueMaxMinor keep the Revenue Inbox join-free).
 */
export async function saveClassification(orgId: OrgId, input: ClassificationInput) {
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new Error("classification_confidence_out_of_range");
  }
  if (input.confidence < REVIEW_CONFIDENCE_THRESHOLD && input.routedTo !== "review_queue") {
    throw new Error("low_confidence_must_route_to_review_queue");
  }
  if (input.label === "uncertain" && input.routedTo !== "review_queue") {
    throw new Error("uncertain_must_route_to_review_queue");
  }
  for (const [field, value] of [["valueMinMinor", input.valueMinMinor], ["valueMaxMinor", input.valueMaxMinor]] as const) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`${field}_must_be_a_nonnegative_safe_integer`);
    }
  }
  if (input.valueMinMinor !== null && input.valueMaxMinor !== null && input.valueMinMinor > input.valueMaxMinor) {
    throw new Error("classification_value_range_invalid");
  }
  return prisma.$transaction(async (tx) => {
    const [message, org] = await Promise.all([
      tx.message.findFirst({
      where: { id: input.messageId, orgId },
      select: { id: true, threadId: true },
      }),
      tx.organization.findUnique({ where: { id: orgId }, select: { currencyCode: true } }),
    ]);
    if (!message) throw new Error(`message ${input.messageId} not in org`);
    if (!org) throw new Error(`org ${orgId} not found`);
    if (input.currencyCode && input.currencyCode !== org.currencyCode) {
      throw new Error("classification_currency_must_match_org_currency");
    }
    await lockThread(tx, message.threadId);

    const fields = {
      label: input.label,
      confidence: input.confidence,
      language: input.language,
      valueMinMinor: input.valueMinMinor,
      valueMaxMinor: input.valueMaxMinor,
      currencyCode: input.currencyCode ?? org.currencyCode,
      rationale: input.rationale,
      modelVersion: input.modelVersion,
      promptVersion: input.promptVersion,
      routedTo: input.routedTo,
      source: input.source ?? "live",
    };

    // Upsert with a real update — a genuine classification MUST overwrite an
    // earlier error/placeholder row (F2), so a retry that finally succeeds wins.
    // The one thing we never clobber is a human review outcome: once a seat has
    // confirmed/overridden, re-runs leave the reviewed row untouched.
    const existing = await tx.classification.findUnique({
      where: { messageId: message.id },
      select: { reviewOutcome: true },
    });
    const classification =
      existing && existing.reviewOutcome !== null
        ? await tx.classification.findUniqueOrThrow({ where: { messageId: message.id } })
        : await tx.classification.upsert({
            where: { messageId: message.id },
            create: { orgId, messageId: message.id, ...fields },
            update: fields,
          });

    // Always derive the summary from the persisted classifications while the
    // thread is locked. This prevents late/retried jobs from leaving a stale
    // max estimate or exposing a thread with a newly queued review item.
    await refreshThreadClassificationState(tx, message.threadId);

    return classification;
  });
}

export async function listReviewQueue(orgId: OrgId, limit = 50) {
  const rows = await prisma.classification.findMany({
    where: { orgId, routedTo: "review_queue", reviewOutcome: null },
    orderBy: { createdAt: "asc" },
    take: limit,
    include: {
      message: {
        select: {
          id: true,
          text: true,
          sentAt: true,
          thread: { select: { id: true, participantHandle: true, igAccountId: true } },
        },
      },
    },
  });
  return rows.map((c) => ({
    classificationId: c.id,
    threadId: c.message.thread.id,
    igAccountId: c.message.thread.igAccountId,
    handle: c.message.thread.participantHandle,
    text: c.message.text,
    sentAt: c.message.sentAt,
    bestGuess: c.label,
    confidence: c.confidence,
    rationale: c.rationale,
  }));
}

/**
 * Review Queue action (PRD §6.6): confirm or override. Outcomes are the
 * labelled training data for per-creator personalization.
 */
export async function reviewClassification(
  orgId: OrgId,
  input: {
    classificationId: string;
    seatId: string;
    outcome: "confirmed" | "overridden";
    overrideLabel?: ClassificationInput["label"];
  }
) {
  return prisma.$transaction(async (tx) => {
    await requireSeatInOrg(orgId, input.seatId, tx, "reviewer_seat_not_in_org");
    let c = await tx.classification.findFirst({
      where: { id: input.classificationId, orgId },
      include: { message: { select: { threadId: true } } },
    });
    if (!c) throw new DomainError("classification not in org", 404);
    await lockThread(tx, c.message.threadId);
    // Re-read after acquiring the per-thread lock: another reviewer may have
    // completed the decision while this transaction waited for the lock.
    c = await tx.classification.findFirst({
      where: { id: input.classificationId, orgId },
      include: { message: { select: { threadId: true } } },
    });
    if (!c) throw new DomainError("classification not in org", 404);
    // An HTTP retry must not overwrite the first human decision, or reassign
    // attribution to a different seat.
    if (c.reviewOutcome !== null) return c;
    if (input.outcome === "overridden" && !input.overrideLabel) {
      throw new DomainError("override requires overrideLabel", 400);
    }

    const effectiveLabel =
      input.outcome === "overridden" ? input.overrideLabel! : c.label;

    const updated = await tx.classification.update({
      where: { id: c.id },
      data: {
        reviewOutcome: input.outcome,
        overrideLabel: input.outcome === "overridden" ? input.overrideLabel : null,
        reviewedBySeatId: input.seatId,
        reviewedAt: new Date(),
        routedTo: "inbox",
        label: effectiveLabel,
      },
    });

    await refreshThreadClassificationState(tx, c.message.threadId);

    await writeAudit(tx, {
      orgId,
      seatId: input.seatId,
      action: "classification.reviewed",
      entityType: "classification",
      entityId: c.id,
      detail: { outcome: input.outcome, from: c.label, to: effectiveLabel },
    });

    return updated;
  });
}

/** Recent overrides → few-shot corrections for the classify prompt (ADR-5). */
export async function listRecentOverrides(orgId: OrgId, igAccountId: string, limit = 10) {
  const rows = await prisma.classification.findMany({
    where: {
      orgId,
      reviewOutcome: "overridden",
      message: { thread: { igAccountId } },
    },
    orderBy: { reviewedAt: "desc" },
    take: limit,
    include: { message: { select: { text: true } } },
  });
  return rows.map((c) => ({
    text: c.message.text,
    correctLabel: c.overrideLabel ?? c.label,
  }));
}
