-- Deals carried from the conversation to the money (agreed → invoiced → paid),
-- and the email channel (Gmail) on the existing account/thread/message model.
-- An email inbox belongs to one creator account (ownerAccountId), so its
-- threads, deals and money count for that creator. Purely additive: new enum
-- values, nullable columns, one new table. The Prisma part is the exact
-- `prisma migrate diff` output for schema.prisma; the CHECK constraints at the
-- end are hand-written, as in earlier migrations.

-- CreateEnum
CREATE TYPE "DealStage" AS ENUM ('agreed', 'invoiced', 'paid', 'cancelled');

-- AlterEnum
ALTER TYPE "Platform" ADD VALUE 'email';

-- AlterEnum
ALTER TYPE "MessagingProviderKind" ADD VALUE 'gmail';

-- AlterTable
ALTER TABLE "IgAccount" ADD COLUMN     "ownerAccountId" TEXT,
ADD COLUMN     "refreshTokenEnc" TEXT;

-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "subject" TEXT;

-- AlterTable
ALTER TABLE "LedgerEntry" ADD COLUMN     "dealId" TEXT;

-- AlterTable
ALTER TABLE "IngestionCheckpoint" ADD COLUMN     "syncCursor" TEXT;

-- CreateTable
CREATE TABLE "Deal" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "dealType" "DealType" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "stage" "DealStage" NOT NULL DEFAULT 'agreed',
    "terms" JSONB NOT NULL,
    "agreedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3),
    "invoicedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "receivedMinor" BIGINT,
    "tdsMinor" BIGINT,
    "idempotencyKey" TEXT NOT NULL,
    "createdBySeatId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Deal_orgId_stage_dueAt_idx" ON "Deal"("orgId", "stage", "dueAt");

-- CreateIndex
CREATE INDEX "Deal_orgId_threadId_idx" ON "Deal"("orgId", "threadId");

-- CreateIndex
CREATE UNIQUE INDEX "Deal_orgId_idempotencyKey_key" ON "Deal"("orgId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_dealId_key" ON "LedgerEntry"("dealId");

-- AddForeignKey
ALTER TABLE "IgAccount" ADD CONSTRAINT "IgAccount_ownerAccountId_fkey" FOREIGN KEY ("ownerAccountId") REFERENCES "IgAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_createdBySeatId_fkey" FOREIGN KEY ("createdBySeatId") REFERENCES "Seat"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Money invariants Prisma does not model (same rules as LedgerEntry/Offer).
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_amountMinor_range" CHECK ("amountMinor" > 0 AND "amountMinor" <= 9007199254740991);
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_receivedMinor_range" CHECK ("receivedMinor" IS NULL OR ("receivedMinor" >= 0 AND "receivedMinor" <= 9007199254740991));
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_tdsMinor_range" CHECK ("tdsMinor" IS NULL OR ("tdsMinor" >= 0 AND "tdsMinor" <= 9007199254740991));
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_currencyCode_supported" CHECK ("currencyCode" IN ('INR', 'USD', 'GBP', 'EUR', 'AED'));
-- A paid deal always says when it was paid.
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_paid_has_date" CHECK ("stage" <> 'paid' OR "paidAt" IS NOT NULL);
-- An inbox can't own itself.
ALTER TABLE "IgAccount" ADD CONSTRAINT "IgAccount_owner_not_self" CHECK ("ownerAccountId" IS NULL OR "ownerAccountId" <> "id");
