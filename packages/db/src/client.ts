import { PrismaClient } from "@prisma/client";

/**
 * INTERNAL to @dealdock/db. The raw client is never exported from the package —
 * apps go through the org-scoped repository layer (ADR-7). CI enforces the
 * boundary via scripts/check-boundaries.mjs.
 */

declare global {
  // eslint-disable-next-line no-var
  var __dealdockPrisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  globalThis.__dealdockPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__dealdockPrisma = prisma;
}
