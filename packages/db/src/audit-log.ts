import type { AuditAction } from "@dealdock/core";
import type { Prisma } from "@prisma/client";

/**
 * One AuditLog row. `action` is one of core's AUDIT_ACTIONS, the names the
 * Activity screen and the web demo store describe; the column stays a plain
 * string so rows written under older names still read back.
 */
export interface AuditEntry {
  orgId: string;
  /** Null for system bookkeeping (nudge.due, digest.weekly_sent). */
  seatId?: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  detail?: Prisma.InputJsonValue;
}

/**
 * Every audit write in this package goes through here. Not async, so the
 * returned PrismaPromise also fits a batch `$transaction([...])`.
 */
export function writeAudit(client: Pick<Prisma.TransactionClient, "auditLog">, entry: AuditEntry) {
  return client.auditLog.create({ data: entry });
}
