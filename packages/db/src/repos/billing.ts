import { DomainError } from "@dealdock/core";
import { prisma } from "../client";
import type { OrgId } from "../org-id";
import { writeAudit } from "../audit-log";
import { requireSeatInOrg } from "../seat-scope";

/**
 * Billing state machine (ARCHITECTURE.md §9, PRD §6.12):
 * pending_first_invoice → (active-use gate +7d → rail subscription created,
 * creator authorizes mandate/checkout) → charged webhook → active.
 * payment_failed → past_due (7-day grace banner, no feature cut).
 * cancel → runs to currentPeriodEnd → read-only mode (ledger + export only).
 */

/** Bootstrap the subscription row at org creation / tier selection. */
export async function ensureSubscription(orgId: OrgId, tier: "solo" | "studio" | "roster") {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { currencyCode: true },
  });
  if (!org) throw new DomainError("org not found", 404);
  const rail = org.currencyCode === "INR" ? "razorpay" : "paddle";
  return prisma.subscription.upsert({
    where: { orgId },
    create: { orgId, rail, tier },
    update: { tier, rail },
  });
}

/** The trust-mechanic clock starts on first real inbox interaction (PRD §6.12). */
export async function markActiveUseStarted(orgId: OrgId) {
  await prisma.subscription.updateMany({
    where: { orgId, activeUseStartedAt: null },
    data: { activeUseStartedAt: new Date() },
  });
}

export async function getSubscription(orgId: OrgId) {
  return prisma.subscription.findUnique({ where: { orgId } });
}

/**
 * SYSTEM CONTEXT (scheduler): orgs whose 7-day active-use gate has elapsed and
 * no rail subscription exists yet. Cross-org by design — results feed per-org
 * jobs; no data crosses orgs.
 */
export async function listSubscriptionsDueFirstInvoice(gateDays = 7) {
  const cutoff = new Date(Date.now() - gateDays * 864e5);
  const subs = await prisma.subscription.findMany({
    where: {
      status: "pending_first_invoice",
      externalId: null,
      firstInvoiceRequestedAt: null,
      activeUseStartedAt: { lte: cutoff },
    },
    include: {
      org: {
        select: {
          id: true,
          name: true,
          currencyCode: true,
          seats: {
            where: { role: "creator" },
            take: 1,
            include: { user: { select: { email: true, name: true } } },
          },
        },
      },
    },
  });
  return subs.map((s) => ({
    orgId: s.orgId,
    tier: s.tier,
    currencyCode: s.org.currencyCode,
    creatorEmail: s.org.seats[0]?.user.email ?? "",
    creatorName: s.org.seats[0]?.user.name ?? s.org.name,
  }));
}

export async function saveRailSubscription(
  orgId: OrgId,
  input: { externalId: string; checkoutUrl: string | null }
) {
  const saved = await prisma.subscription.updateMany({
    // A cancellation may have won while a remote checkout was being created.
    // Do not resurrect that subscription locally; caller can cancel the newly
    // created remote checkout using its provider id.
    where: { orgId, status: "pending_first_invoice", externalId: null },
    data: {
      externalId: input.externalId,
      checkoutUrl: input.checkoutUrl,
      firstInvoiceRequestedAt: new Date(),
    },
  });
  return { saved: saved.count === 1 };
}

/**
 * Atomically reserve an eligible first-invoice creation before calling a rail.
 * Schedulers must call this, then release the reservation on a definite remote
 * failure. This closes the two-worker duplicate-checkout race.
 */
export async function claimFirstInvoice(orgId: OrgId, gateDays = 7, now = new Date()) {
  const cutoff = new Date(now.getTime() - gateDays * 864e5);
  const claimed = await prisma.subscription.updateMany({
    where: {
      orgId,
      status: "pending_first_invoice",
      externalId: null,
      firstInvoiceRequestedAt: null,
      activeUseStartedAt: { lte: cutoff },
    },
    data: { firstInvoiceRequestedAt: now },
  });
  if (!claimed.count) return null;
  return prisma.subscription.findUnique({
    where: { orgId },
    select: { orgId: true, tier: true, rail: true },
  }).then((subscription) => subscription ? { ...subscription, claimedAt: now } : null);
}

export async function releaseFirstInvoiceClaim(orgId: OrgId, claimedAt: Date) {
  await prisma.subscription.updateMany({
    where: { orgId, status: "pending_first_invoice", externalId: null, firstInvoiceRequestedAt: claimedAt },
    data: { firstInvoiceRequestedAt: null },
  });
}

/** Normalized webhook/reconciliation event → state transition. Replay-tolerant. */
export async function applyBillingEvent(input: {
  rail: "razorpay" | "paddle";
  eventId?: string;
  occurredAt?: Date;
  externalId: string;
  kind: "charged" | "payment_failed" | "cancelled" | "activated" | "unknown";
  currentPeriodEnd?: Date;
  /** Paddle: transaction id is provisional; the durable sub id replaces it. */
  provisionalExternalId?: string;
  /**
   * Rail-echoed org tag (custom_data / notes) — the durable resolution key.
   * subscription.activated carries the new sub_… id while our row still holds
   * the provisional txn_… id, so neither external-id lookup matches; orgId is
   * how we bind the durable id onto the right org's row (F5).
   */
  orgId?: string;
}) {
  return prisma.$transaction(async tx => {
  let sub =
    (await tx.subscription.findUnique({ where: { externalId: input.externalId } })) ??
    (input.provisionalExternalId && input.provisionalExternalId !== input.externalId
      ? await tx.subscription.findUnique({
          where: { externalId: input.provisionalExternalId },
        })
      : null) ??
    (input.orgId
      ? await tx.subscription.findUnique({ where: { orgId: input.orgId } })
      : null);
  if (!sub) return { applied: false as const, reason: "unknown_external_id" as const };
  await tx.$queryRaw`SELECT "id" FROM "Subscription" WHERE "id" = ${sub.id} FOR UPDATE`;
  sub = await tx.subscription.findUniqueOrThrow({where:{id:sub.id}});
  if (input.orgId && input.orgId !== sub.orgId) return {applied:false as const,reason:"billing_org_mismatch" as const,orgId:sub.orgId};
  if (sub.rail !== input.rail) return {applied:false as const,reason:"wrong_billing_rail" as const,orgId:sub.orgId};
  // Only a provisional Paddle transaction may be replaced by a durable sub id.
  // An arbitrary webhook org tag cannot attach a second subscription to a tenant.
  if (sub.externalId && sub.externalId !== input.externalId && !(sub.rail === "paddle" && sub.externalId.startsWith("txn_") && input.externalId.startsWith("sub_"))) return {applied:false as const,reason:"external_id_mismatch" as const,orgId:sub.orgId};
  if (input.eventId) {
    const receipt = await tx.billingEventReceipt.createMany({data:[{rail:input.rail,eventId:input.eventId,orgId:sub.orgId,occurredAt:input.occurredAt}],skipDuplicates:true});
    if (!receipt.count) return {applied:true as const,orgId:sub.orgId,status:sub.status,deduplicated:true};
  }
  if (input.occurredAt && sub.lastEventAt && input.occurredAt < sub.lastEventAt) return {applied:true as const,orgId:sub.orgId,status:sub.status,ignoredStale:true};

  // cancelled is TERMINAL. A replayed or out-of-order "charged"/"activated"
  // event must never resurrect a cancelled subscription and silently escape
  // read-only mode (F3). Only an idempotent re-cancel is accepted afterward.
  if (sub.status === "cancelled" && input.kind !== "cancelled") {
    return {
      applied: false as const,
      orgId: sub.orgId,
      reason: "subscription_cancelled_terminal" as const,
    };
  }

  const data: Record<string, unknown> = {};
  if (input.occurredAt) data.lastEventAt = input.occurredAt;
  if (input.eventId) data.lastEventId = input.eventId;
  if (sub.externalId !== input.externalId) data.externalId = input.externalId;
  if (input.currentPeriodEnd && (!sub.currentPeriodEnd || input.currentPeriodEnd > sub.currentPeriodEnd)) data.currentPeriodEnd = input.currentPeriodEnd;

  switch (input.kind) {
    case "charged":
      data.status = "active";
      data.checkoutUrl = null;
      break;
    case "payment_failed":
      // Grace: banner only, no feature cut for 7 days (ARCHITECTURE.md §9).
      if (sub.status === "active" || sub.status === "past_due") data.status = "past_due";
      break;
    case "cancelled":
      data.status = "cancelled";
      data.cancelledAt = sub.cancelledAt ?? new Date();
      break;
    case "activated":
    case "unknown":
      break; // mandate authorized / no-op; first charge flips to active
  }

  await tx.subscription.update({ where: { id: sub.id }, data: data as never });
  return {
    applied: true as const,
    orgId: sub.orgId,
    status: (data.status as string) ?? sub.status,
  };
  });
}

export async function requestCancellation(orgId: OrgId, seatId: string) {
  return prisma.$transaction(async (tx) => {
    await requireSeatInOrg(orgId, seatId, tx);
    const sub = await tx.subscription.findUnique({ where: { orgId } });
    if (!sub) throw new Error("no_subscription");
    if (sub.cancelledAt) return sub;
    const now = new Date();
    const pendingWithoutRemote = sub.status === "pending_first_invoice" && sub.externalId === null;
    const updated = await tx.subscription.update({
      where: { id: sub.id },
      data: {
        cancelledAt: now,
        // Before a checkout exists there is nothing that can legitimately
        // reactivate this row. Make it terminal immediately and block a
        // concurrently claimed invoice from being saved.
        ...(pendingWithoutRemote ? { status: "cancelled", currentPeriodEnd: now } : {}),
      },
    });
    await writeAudit(tx, {
      orgId,
      seatId,
      action: "billing.cancel_requested",
      entityType: "subscription",
      entityId: sub.id,
    });
    return updated;
  });
}

/** SYSTEM CONTEXT (reconciliation poller): all subs with a rail id. */
export async function listSubscriptionsForReconciliation() {
  return prisma.subscription.findMany({
    where: { externalId: { not: null }, status: { not: "cancelled" } },
    select: { orgId: true, rail: true, externalId: true, status: true },
  });
}

/**
 * Read-only mode check (PRD §5.7): cancelled + past period end → ledger and
 * export only. Orgs without a subscription row (pre-billing pilot) are writable.
 */
export async function isOrgReadOnly(orgId: OrgId): Promise<boolean> {
  const sub = await prisma.subscription.findUnique({
    where: { orgId },
    select: { status: true, currentPeriodEnd: true },
  });
  if (!sub) return false;
  if (sub.status !== "cancelled") return false;
  return !sub.currentPeriodEnd || sub.currentPeriodEnd.getTime() < Date.now();
}
