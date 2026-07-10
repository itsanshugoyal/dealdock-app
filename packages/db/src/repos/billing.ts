import { prisma } from "../client";
import type { OrgId } from "../org-id";

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
  if (!org) throw new Error("org not found");
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
  await prisma.subscription.update({
    where: { orgId },
    data: {
      externalId: input.externalId,
      checkoutUrl: input.checkoutUrl,
      firstInvoiceRequestedAt: new Date(),
    },
  });
}

/** Normalized webhook/reconciliation event → state transition. Replay-tolerant. */
export async function applyBillingEvent(input: {
  externalId: string;
  kind: "charged" | "payment_failed" | "cancelled" | "activated" | "unknown";
  currentPeriodEnd?: Date;
  /** Paddle: transaction id is provisional; the durable sub id replaces it. */
  provisionalExternalId?: string;
}) {
  const sub =
    (await prisma.subscription.findUnique({ where: { externalId: input.externalId } })) ??
    (input.provisionalExternalId
      ? await prisma.subscription.findUnique({
          where: { externalId: input.provisionalExternalId },
        })
      : null);
  if (!sub) return { applied: false as const, reason: "unknown_external_id" };

  const data: Record<string, unknown> = {};
  if (sub.externalId !== input.externalId) data.externalId = input.externalId;
  if (input.currentPeriodEnd) data.currentPeriodEnd = input.currentPeriodEnd;

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

  await prisma.subscription.update({ where: { id: sub.id }, data: data as never });
  return { applied: true as const, orgId: sub.orgId, status: (data.status as string) ?? sub.status };
}

export async function requestCancellation(orgId: OrgId, seatId: string) {
  const sub = await prisma.subscription.findUnique({ where: { orgId } });
  if (!sub) throw new Error("no subscription");
  await prisma.subscription.update({
    where: { id: sub.id },
    data: { cancelledAt: new Date() },
  });
  await prisma.auditLog.create({
    data: {
      orgId,
      seatId,
      action: "billing.cancel_requested",
      entityType: "subscription",
      entityId: sub.id,
    },
  });
  return sub;
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
