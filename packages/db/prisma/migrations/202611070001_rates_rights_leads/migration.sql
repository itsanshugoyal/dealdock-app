-- Phase 2 and 3: rate-card add-ons and a private rate-card link, usage-rights
-- and renewal reminders, the coach pipeline (stages plus booking and payment
-- tools that report back) and comment leads.
--
-- The Prisma part is the exact `prisma migrate diff` output from the schema
-- after 202611060001 to this one. The CHECKs at the end are hand-written.

-- CreateEnum
CREATE TYPE "LeadStage" AS ENUM ('lead', 'qualified', 'booked', 'paid');

-- CreateEnum
CREATE TYPE "LeadSourceProvider" AS ENUM ('calendly', 'cal_com', 'razorpay', 'stripe', 'other');

-- CreateEnum
CREATE TYPE "LeadEventKind" AS ENUM ('booked', 'paid');

-- CreateEnum
CREATE TYPE "CommentLeadStatus" AS ENUM ('new', 'sending', 'sent', 'skipped');

-- AlterTable
ALTER TABLE "IgAccount" ADD COLUMN     "commentKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "rateCardToken" TEXT;

-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "leadStage" "LeadStage",
ADD COLUMN     "leadStageAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Deal" ADD COLUMN     "renewalHandledAt" TIMESTAMP(3),
ADD COLUMN     "usageHandledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Offer" ADD COLUMN     "addOns" JSONB;

-- CreateTable
CREATE TABLE "LeadSource" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" "LeadSourceProvider" NOT NULL,
    "label" TEXT,
    "tokenHash" TEXT NOT NULL,
    "secretEnc" TEXT,
    "lastEventAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "kind" "LeadEventKind" NOT NULL,
    "threadId" TEXT,
    "amountMinor" BIGINT,
    "currencyCode" TEXT,
    "payerName" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "handledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommentLead" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "igAccountId" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "mediaUrl" TEXT,
    "commenterIgId" TEXT NOT NULL,
    "commenterHandle" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "commentedAt" TIMESTAMP(3) NOT NULL,
    "status" "CommentLeadStatus" NOT NULL DEFAULT 'new',
    "draftBody" TEXT,
    "modelVersion" TEXT,
    "sentAt" TIMESTAMP(3),
    "sentBySeatId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommentLead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeadSource_tokenHash_key" ON "LeadSource"("tokenHash");

-- CreateIndex
CREATE INDEX "LeadSource_orgId_idx" ON "LeadSource"("orgId");

-- CreateIndex
CREATE INDEX "LeadEvent_orgId_threadId_idx" ON "LeadEvent"("orgId", "threadId");

-- CreateIndex
CREATE INDEX "LeadEvent_orgId_handledAt_idx" ON "LeadEvent"("orgId", "handledAt");

-- CreateIndex
CREATE UNIQUE INDEX "LeadEvent_sourceId_externalId_key" ON "LeadEvent"("sourceId", "externalId");

-- CreateIndex
CREATE INDEX "CommentLead_orgId_status_commentedAt_idx" ON "CommentLead"("orgId", "status", "commentedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommentLead_igAccountId_commentId_key" ON "CommentLead"("igAccountId", "commentId");

-- CreateIndex
CREATE UNIQUE INDEX "IgAccount_rateCardToken_key" ON "IgAccount"("rateCardToken");

-- AddForeignKey
ALTER TABLE "LeadSource" ADD CONSTRAINT "LeadSource_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadEvent" ADD CONSTRAINT "LeadEvent_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "LeadSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadEvent" ADD CONSTRAINT "LeadEvent_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentLead" ADD CONSTRAINT "CommentLead_igAccountId_fkey" FOREIGN KEY ("igAccountId") REFERENCES "IgAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A payment carries its currency; amounts are never negative.
ALTER TABLE "LeadEvent" ADD CONSTRAINT "LeadEvent_amount_check" CHECK ("amountMinor" IS NULL OR ("amountMinor" >= 0 AND "currencyCode" IS NOT NULL));

-- A private reply is sent exactly when it is marked sent.
ALTER TABLE "CommentLead" ADD CONSTRAINT "CommentLead_sent_check" CHECK (("status" = 'sent') = ("sentAt" IS NOT NULL));

-- Comment leads keep the facts their draft was missing (prisma migrate diff of that one column).
-- AlterTable
ALTER TABLE "CommentLead" ADD COLUMN     "missingFacts" TEXT[] DEFAULT ARRAY[]::TEXT[];
