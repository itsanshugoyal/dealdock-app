import { prisma } from "../client";
import type { OrgId } from "../org-id";
import { requireSeatInOrg } from "../seat-scope";
import { DomainError, isTrustedPushEndpoint } from "@dealdock/core";

export async function savePushSubscription(
  orgId: OrgId,
  seatId: string,
  input: { endpoint: string; p256dh: string; auth: string }
) {
  await requireSeatInOrg(orgId, seatId);
  if (!isTrustedPushEndpoint(input.endpoint)) throw new DomainError("unsupported_push_endpoint", 400);
  // Endpoints are globally unique. If the same browser endpoint was previously
  // registered under a DIFFERENT org (shared device / reused profile), don't
  // just patch keys — that leaves the row tagged with the old org but keyed for
  // the new subscriber, so listPushTargets would push org A's alerts using
  // org B's keys (F13). Reassign the whole row (orgId included) to the caller.
  const existing = await prisma.pushSubscription.findUnique({
    where: { endpoint: input.endpoint },
    select: { id: true },
  });
  if (existing) {
    return prisma.pushSubscription.update({
      where: { endpoint: input.endpoint },
      data: { orgId, seatId, p256dh: input.p256dh, auth: input.auth },
    });
  }
  return prisma.pushSubscription.create({ data: { orgId, seatId, ...input } });
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

/** Settings-safe view: if a device has not opted in yet, expose product defaults. */
export async function getPushPreferences(orgId: OrgId, seatId: string) {
  const rows = await prisma.pushSubscription.findMany({
    where: { orgId, seatId },
    select: { notifyHighValue: true, notifyNudge: true, notifyWeeklySummary: true },
  });
  if (rows.length === 0) {
    return { notifyHighValue: true, notifyNudge: true, notifyWeeklySummary: true, subscribed: false };
  }
  // A seat may have multiple devices. A setting change is written to all, and
  // conservative aggregation avoids claiming a disabled notification is on.
  return {
    notifyHighValue: rows.every((row) => row.notifyHighValue),
    notifyNudge: rows.every((row) => row.notifyNudge),
    notifyWeeklySummary: rows.every((row) => row.notifyWeeklySummary),
    subscribed: true,
  };
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
