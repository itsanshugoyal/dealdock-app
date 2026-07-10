import { prisma } from "../client";
import type { OrgId } from "../org-id";

export async function savePushSubscription(
  orgId: OrgId,
  seatId: string,
  input: { endpoint: string; p256dh: string; auth: string }
) {
  return prisma.pushSubscription.upsert({
    where: { endpoint: input.endpoint },
    create: { orgId, seatId, ...input },
    update: { seatId, p256dh: input.p256dh, auth: input.auth },
  });
}

export async function deletePushSubscription(orgId: OrgId, endpoint: string) {
  await prisma.pushSubscription.deleteMany({ where: { orgId, endpoint } });
}

export async function updatePushPrefs(
  orgId: OrgId,
  seatId: string,
  prefs: {
    notifyHighValue?: boolean;
    notifyNudge?: boolean;
    notifyWeeklySummary?: boolean;
  }
) {
  await prisma.pushSubscription.updateMany({ where: { orgId, seatId }, data: prefs });
}

export type NotifyKind = "high_value" | "nudge" | "weekly_summary" | "billing_checkout_ready";

/**
 * SYSTEM CONTEXT (notification sender): subscriptions for an org filtered by
 * the notification kind's toggle + the org's quiet hours (PRD §6.8 — pushes
 * respect the org timezone, 8am–11pm).
 */
export async function listPushTargets(orgId: OrgId, kind: NotifyKind) {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { timezone: true },
  });
  if (!org) return [];

  // Quiet hours: local hour must be within 8–23.
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: org.timezone,
    }).format(new Date())
  );
  if (hour < 8 || hour >= 23) return [];

  const where: Record<string, unknown> = { orgId };
  if (kind === "high_value") where.notifyHighValue = true;
  if (kind === "nudge") where.notifyNudge = true;
  if (kind === "weekly_summary") where.notifyWeeklySummary = true;
  // billing_checkout_ready is not user-toggleable — it's account-critical.

  return prisma.pushSubscription.findMany({
    where,
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
}

export async function removeDeadSubscription(id: string) {
  await prisma.pushSubscription.delete({ where: { id } }).catch(() => {});
}
