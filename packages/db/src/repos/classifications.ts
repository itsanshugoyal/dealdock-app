import { prisma } from "../client";
import type { OrgId } from "../org-id";

const HIGH_INTENT = ["brand_deal", "coaching_lead", "course_inquiry", "other_commerce"] as const;

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
  return prisma.$transaction(async (tx) => {
    const message = await tx.message.findFirst({
      where: { id: input.messageId, orgId },
      select: { id: true, threadId: true },
    });
    if (!message) throw new Error(`message ${input.messageId} not in org`);

    const classification = await tx.classification.upsert({
      where: { messageId: message.id },
      create: {
        orgId,
        messageId: message.id,
        label: input.label,
        confidence: input.confidence,
        language: input.language,
        valueMinMinor: input.valueMinMinor,
        valueMaxMinor: input.valueMaxMinor,
        rationale: input.rationale,
        modelVersion: input.modelVersion,
        promptVersion: input.promptVersion,
        routedTo: input.routedTo,
        source: input.source ?? "live",
      },
      update: {}, // idempotent: first classification wins; re-runs are no-ops
    });

    // Denormalize onto the thread when this raises its top value / adds a commerce label.
    if (
      input.routedTo === "inbox" &&
      (HIGH_INTENT as readonly string[]).includes(input.label)
    ) {
      const thread = await tx.thread.findUnique({
        where: { id: message.threadId },
        select: { estValueMaxMinor: true },
      });
      const current = thread?.estValueMaxMinor ?? null;
      const incoming = input.valueMaxMinor;
      if (incoming !== null && (current === null || BigInt(incoming) > current)) {
        await tx.thread.update({
          where: { id: message.threadId },
          data: { topLabel: input.label, estValueMaxMinor: BigInt(incoming) },
        });
      } else if (current === null) {
        await tx.thread.update({
          where: { id: message.threadId },
          data: { topLabel: input.label },
        });
      }
    }

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
          thread: { select: { id: true, participantHandle: true } },
        },
      },
    },
  });
  return rows.map((c) => ({
    classificationId: c.id,
    threadId: c.message.thread.id,
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
    const c = await tx.classification.findFirst({
      where: { id: input.classificationId, orgId },
      include: { message: { select: { threadId: true } } },
    });
    if (!c) throw new Error("classification not in org");
    if (input.outcome === "overridden" && !input.overrideLabel) {
      throw new Error("override requires overrideLabel");
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

    if (
      (HIGH_INTENT as readonly string[]).includes(effectiveLabel) &&
      c.valueMaxMinor !== null
    ) {
      await tx.thread.update({
        where: { id: c.message.threadId },
        data: { topLabel: effectiveLabel, estValueMaxMinor: c.valueMaxMinor },
      });
    }

    await tx.auditLog.create({
      data: {
        orgId,
        seatId: input.seatId,
        action: "classification.reviewed",
        entityType: "classification",
        entityId: c.id,
        detail: { outcome: input.outcome, from: c.label, to: effectiveLabel },
      },
    });

    return updated;
  });
}

/** Recent overrides → few-shot corrections for the classify prompt (ADR-5). */
export async function listRecentOverrides(orgId: OrgId, limit = 10) {
  const rows = await prisma.classification.findMany({
    where: { orgId, reviewOutcome: "overridden" },
    orderBy: { reviewedAt: "desc" },
    take: limit,
    include: { message: { select: { text: true } } },
  });
  return rows.map((c) => ({
    text: c.message.text,
    correctLabel: c.overrideLabel ?? c.label,
  }));
}
