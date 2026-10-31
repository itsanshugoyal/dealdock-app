-- Safety invariants: immutable money context, strict review isolation,
-- deletion-complete webhook ownership, durable ingress, and send intents.

CREATE TYPE "SendIntentStatus" AS ENUM ('pending', 'remote_accepted', 'persisted', 'unknown');

ALTER TABLE "Thread"
  ADD COLUMN "hasPendingReview" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Classification" ADD COLUMN "currencyCode" TEXT NOT NULL DEFAULT 'INR';
UPDATE "Classification" c
SET "currencyCode" = o."currencyCode"
FROM "Organization" o
WHERE c."orgId" = o."id";

ALTER TABLE "Thread" ADD COLUMN "estCurrencyCode" TEXT;
UPDATE "Thread" t
SET "estCurrencyCode" = c."currencyCode"
FROM "Classification" c
WHERE c."messageId" IN (
  SELECT m."id" FROM "Message" m WHERE m."threadId" = t."id"
)
AND c."valueMaxMinor" = t."estValueMaxMinor"
AND c."routedTo" = 'inbox';

UPDATE "Thread" t
SET "hasPendingReview" = true
WHERE EXISTS (
  SELECT 1 FROM "Message" m
  JOIN "Classification" c ON c."messageId" = m."id"
  WHERE m."threadId" = t."id"
    AND c."routedTo" = 'review_queue'
    AND c."reviewOutcome" IS NULL
);

ALTER TABLE "LedgerEntry" ADD COLUMN "idempotencyKey" TEXT;
UPDATE "LedgerEntry" SET "idempotencyKey" = 'legacy:' || "id" WHERE "idempotencyKey" IS NULL;
ALTER TABLE "LedgerEntry" ALTER COLUMN "idempotencyKey" SET NOT NULL;
CREATE UNIQUE INDEX "LedgerEntry_orgId_idempotencyKey_key" ON "LedgerEntry"("orgId", "idempotencyKey");

ALTER TABLE "VoiceProfile"
  ADD COLUMN "consentedAt" TIMESTAMP(3),
  ADD COLUMN "revokedAt" TIMESTAMP(3),
  ALTER COLUMN "enabled" SET DEFAULT false;
-- Existing profiles predate explicit consent; retain them for export/deletion,
-- but never use them for new drafting until the creator opts in again.
UPDATE "VoiceProfile" SET "enabled" = false, "revokedAt" = NOW();

ALTER TABLE "IgnoreListEntry" ADD COLUMN "igAccountId" TEXT;
ALTER TABLE "IgnoreListEntry" DROP CONSTRAINT IF EXISTS "IgnoreListEntry_orgId_handle_key";
CREATE UNIQUE INDEX "IgnoreListEntry_orgId_handle_orgwide_key"
  ON "IgnoreListEntry"("orgId", "handle") WHERE "igAccountId" IS NULL;
CREATE UNIQUE INDEX "IgnoreListEntry_orgId_igAccountId_handle_account_key"
  ON "IgnoreListEntry"("orgId", "igAccountId", "handle") WHERE "igAccountId" IS NOT NULL;
CREATE INDEX "IgnoreListEntry_orgId_igAccountId_handle_idx"
  ON "IgnoreListEntry"("orgId", "igAccountId", "handle");
ALTER TABLE "IgnoreListEntry"
  ADD CONSTRAINT "IgnoreListEntry_igAccountId_fkey"
  FOREIGN KEY ("igAccountId") REFERENCES "IgAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "WebhookEventOrg" (
  "webhookEventId" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  CONSTRAINT "WebhookEventOrg_pkey" PRIMARY KEY ("webhookEventId", "orgId"),
  CONSTRAINT "WebhookEventOrg_webhookEventId_fkey" FOREIGN KEY ("webhookEventId") REFERENCES "WebhookEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WebhookEventOrg_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "WebhookEventOrg_orgId_idx" ON "WebhookEventOrg"("orgId");

CREATE TABLE "OutboxEvent" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "webhookEventId" TEXT,
  "kind" TEXT NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "leasedAt" TIMESTAMP(3),
  "leaseExpiresAt" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OutboxEvent_dedupeKey_key" UNIQUE ("dedupeKey"),
  CONSTRAINT "OutboxEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OutboxEvent_webhookEventId_fkey" FOREIGN KEY ("webhookEventId") REFERENCES "WebhookEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "OutboxEvent_kind_processedAt_leaseExpiresAt_idx" ON "OutboxEvent"("kind", "processedAt", "leaseExpiresAt");
CREATE INDEX "OutboxEvent_orgId_createdAt_idx" ON "OutboxEvent"("orgId", "createdAt");

CREATE TABLE "SendIntent" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "draftId" TEXT NOT NULL,
  "seatId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "finalText" TEXT NOT NULL,
  "status" "SendIntentStatus" NOT NULL DEFAULT 'pending',
  "platformMessageId" TEXT,
  "platformSentAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SendIntent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SendIntent_draftId_key" UNIQUE ("draftId"),
  CONSTRAINT "SendIntent_orgId_idempotencyKey_key" UNIQUE ("orgId", "idempotencyKey"),
  CONSTRAINT "SendIntent_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "Draft"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SendIntent_orgId_status_idx" ON "SendIntent"("orgId", "status");

-- Ledger rows must not make the promised hard deletion impossible. The old
-- restrictive foreign keys could block Thread/Seat deletion; keep attribution
-- while present, but cascade through a deleted conversation and null a removed
-- seat. This is intentionally a forward-only repair for deployed 0_init DBs.
ALTER TABLE "LedgerEntry" DROP CONSTRAINT IF EXISTS "LedgerEntry_threadId_fkey";
ALTER TABLE "LedgerEntry"
  ADD CONSTRAINT "LedgerEntry_threadId_fkey"
  FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LedgerEntry" DROP CONSTRAINT IF EXISTS "LedgerEntry_createdBySeatId_fkey";
ALTER TABLE "LedgerEntry" ALTER COLUMN "createdBySeatId" DROP NOT NULL;
ALTER TABLE "LedgerEntry"
  ADD CONSTRAINT "LedgerEntry_createdBySeatId_fkey"
  FOREIGN KEY ("createdBySeatId") REFERENCES "Seat"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Database-level guards complement zod/repository checks: no float-like or
-- negative money, impossible value ranges, invalid confidence, or accidental
-- unrecognised organisation currencies can be persisted by a future caller.
ALTER TABLE "Organization"
  ADD CONSTRAINT "Organization_currencyCode_supported"
  CHECK ("currencyCode" IN ('INR', 'USD', 'GBP', 'EUR', 'AED'));
ALTER TABLE "LedgerEntry"
  ADD CONSTRAINT "LedgerEntry_amountMinor_positive" CHECK ("amountMinor" > 0);
ALTER TABLE "Classification"
  ADD CONSTRAINT "Classification_confidence_range" CHECK ("confidence" >= 0 AND "confidence" <= 1),
  ADD CONSTRAINT "Classification_value_range" CHECK (
    ("valueMinMinor" IS NULL OR "valueMinMinor" >= 0) AND
    ("valueMaxMinor" IS NULL OR "valueMaxMinor" >= 0) AND
    ("valueMinMinor" IS NULL OR "valueMaxMinor" IS NULL OR "valueMinMinor" <= "valueMaxMinor")
  );
