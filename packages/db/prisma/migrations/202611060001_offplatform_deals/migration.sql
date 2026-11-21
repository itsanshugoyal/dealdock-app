-- Deals agreed outside DealDock (on a call, on WhatsApp, in person) and their
-- payments: Deal and LedgerEntry no longer need a thread. Every row now
-- stores its creator account (an email inbox's owner, never the inbox) and
-- its counterparty, and account or privacy deletion reaches rows without a
-- thread through that account (ON DELETE CASCADE).
--
-- The Prisma part is the exact `prisma migrate diff` output from the schema
-- after 202611050001 to this one with the four new required columns still
-- optional: added NOT NULL straight away they would fail on a LedgerEntry
-- table that has rows. The backfill and the SET NOT NULL at the end are
-- hand-written, so the end state is exactly schema.prisma.

-- AlterTable
ALTER TABLE "LedgerEntry" ADD COLUMN     "counterpartyHandle" TEXT,
ADD COLUMN     "igAccountId" TEXT,
ALTER COLUMN "threadId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Deal" ADD COLUMN     "counterpartyHandle" TEXT,
ADD COLUMN     "counterpartyName" TEXT,
ADD COLUMN     "igAccountId" TEXT,
ALTER COLUMN "threadId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "LedgerEntry_orgId_igAccountId_closedAt_idx" ON "LedgerEntry"("orgId", "igAccountId", "closedAt");

-- CreateIndex
CREATE INDEX "Deal_orgId_igAccountId_idx" ON "Deal"("orgId", "igAccountId");

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_igAccountId_fkey" FOREIGN KEY ("igAccountId") REFERENCES "IgAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_igAccountId_fkey" FOREIGN KEY ("igAccountId") REFERENCES "IgAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill from each row's thread (every existing row has one): the creator is
-- the thread's account, or its owner when that account is an email inbox; the
-- counterparty is the thread's participant.
UPDATE "Deal" AS d
SET "igAccountId" = COALESCE(a."ownerAccountId", a."id"),
    "counterpartyHandle" = t."participantHandle",
    "counterpartyName" = t."participantName"
FROM "Thread" AS t
JOIN "IgAccount" AS a ON a."id" = t."igAccountId"
WHERE t."id" = d."threadId";

UPDATE "LedgerEntry" AS e
SET "igAccountId" = COALESCE(a."ownerAccountId", a."id"),
    "counterpartyHandle" = t."participantHandle"
FROM "Thread" AS t
JOIN "IgAccount" AS a ON a."id" = t."igAccountId"
WHERE t."id" = e."threadId";

ALTER TABLE "Deal" ALTER COLUMN "igAccountId" SET NOT NULL,
ALTER COLUMN "counterpartyHandle" SET NOT NULL;

ALTER TABLE "LedgerEntry" ALTER COLUMN "igAccountId" SET NOT NULL,
ALTER COLUMN "counterpartyHandle" SET NOT NULL;
