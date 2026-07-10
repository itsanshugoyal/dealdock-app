/**
 * @dealdock/db — org-scoped repository layer over Prisma (ADR-7).
 *
 * The raw PrismaClient is intentionally NOT exported. Every exported function
 * takes `OrgId` as its first argument — the single tenancy chokepoint.
 * `scripts/check-boundaries.mjs` (CI) bans `@prisma/client` imports elsewhere.
 */

export { asOrgId, type OrgId } from "./org-id";
export * from "./repos/orgs";
export * from "./repos/ingestion";
export * from "./repos/inbox";
export * from "./repos/classifications";
export * from "./repos/threads";
export * from "./repos/drafts";
export * from "./repos/ledger";
export * from "./repos/creator-context";
export * from "./repos/system";
export * from "./repos/metrics";
export * from "./repos/voice";
export * from "./repos/ig-accounts";
export * from "./repos/billing";
export * from "./repos/seats";
export * from "./repos/push";
export * from "./repos/settings";
export * from "./repos/retention";
