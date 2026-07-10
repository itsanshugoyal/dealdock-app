-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Tier" AS ENUM ('solo', 'studio', 'roster');

-- CreateEnum
CREATE TYPE "SeatRole" AS ENUM ('creator', 'assistant', 'manager');

-- CreateEnum
CREATE TYPE "IgAccountStatus" AS ENUM ('active', 'disconnected', 'token_expired');

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('instagram', 'whatsapp');

-- CreateEnum
CREATE TYPE "MessagingProviderKind" AS ENUM ('mock', 'instagram_graph');

-- CreateEnum
CREATE TYPE "ThreadState" AS ENUM ('open', 'waiting', 'closed');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('inbound', 'outbound');

-- CreateEnum
CREATE TYPE "ContentType" AS ENUM ('text', 'audio', 'attachment');

-- CreateEnum
CREATE TYPE "ClassificationLabel" AS ENUM ('brand_deal', 'coaching_lead', 'course_inquiry', 'other_commerce', 'fan', 'spam', 'personal', 'uncertain');

-- CreateEnum
CREATE TYPE "MessageLanguage" AS ENUM ('en', 'hi', 'hinglish', 'mixed');

-- CreateEnum
CREATE TYPE "RoutedTo" AS ENUM ('inbox', 'review_queue');

-- CreateEnum
CREATE TYPE "ReviewOutcome" AS ENUM ('confirmed', 'overridden');

-- CreateEnum
CREATE TYPE "ClassificationSource" AS ENUM ('live', 'leak_scan');

-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('ready', 'edited', 'sending', 'sent', 'discarded');

-- CreateEnum
CREATE TYPE "DraftKind" AS ENUM ('reply', 'nudge');

-- CreateEnum
CREATE TYPE "DealType" AS ENUM ('brand', 'coaching', 'course', 'other');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('pending_first_invoice', 'active', 'past_due', 'cancelled');

-- CreateEnum
CREATE TYPE "BillingRail" AS ENUM ('razorpay', 'paddle');

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tier" "Tier" NOT NULL DEFAULT 'solo',
    "pilotCohort" BOOLEAN NOT NULL DEFAULT true,
    "pricingLockedAt" TIMESTAMP(3),
    "currencyCode" TEXT NOT NULL DEFAULT 'INR',
    "locale" TEXT NOT NULL DEFAULT 'en-IN',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "nudgeDelayDays" INTEGER NOT NULL DEFAULT 3,
    "businessContext" JSONB,
    "deletionRequestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "clerkUserId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Seat" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "SeatRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Seat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IgAccount" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL DEFAULT 'instagram',
    "provider" "MessagingProviderKind" NOT NULL DEFAULT 'mock',
    "igUserId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "accessTokenEnc" TEXT,
    "status" "IgAccountStatus" NOT NULL DEFAULT 'active',
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnectedAt" TIMESTAMP(3),

    CONSTRAINT "IgAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Thread" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "igAccountId" TEXT NOT NULL,
    "igThreadId" TEXT NOT NULL,
    "participantHandle" TEXT NOT NULL,
    "participantIgId" TEXT NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL,
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "state" "ThreadState" NOT NULL DEFAULT 'open',
    "waitingSince" TIMESTAMP(3),
    "nudgeDismissedAt" TIMESTAMP(3),
    "topLabel" "ClassificationLabel",
    "estValueMaxMinor" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Thread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "igMessageId" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "contentType" "ContentType" NOT NULL DEFAULT 'text',
    "text" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Classification" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "label" "ClassificationLabel" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "language" "MessageLanguage" NOT NULL,
    "valueMinMinor" BIGINT,
    "valueMaxMinor" BIGINT,
    "rationale" TEXT,
    "modelVersion" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "routedTo" "RoutedTo" NOT NULL,
    "source" "ClassificationSource" NOT NULL DEFAULT 'live',
    "reviewedBySeatId" TEXT,
    "reviewOutcome" "ReviewOutcome",
    "overrideLabel" "ClassificationLabel",
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Classification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Draft" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "replyToMessageId" TEXT,
    "kind" "DraftKind" NOT NULL DEFAULT 'reply',
    "body" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "DraftStatus" NOT NULL DEFAULT 'ready',
    "modelVersion" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "sentBySeatId" TEXT,
    "sentMessageId" TEXT,
    "finalText" TEXT,
    "editDistance" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Draft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "dealType" "DealType" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "note" TEXT,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBySeatId" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceProfile" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "igAccountId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "styleCard" JSONB,
    "sampleMessageIds" TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "refreshedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoiceProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IgnoreListEntry" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IgnoreListEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "seatId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "rail" "BillingRail" NOT NULL,
    "externalId" TEXT,
    "checkoutUrl" TEXT,
    "tier" "Tier" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'pending_first_invoice',
    "activeUseStartedAt" TIMESTAMP(3),
    "firstInvoiceRequestedAt" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngestionCheckpoint" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "igAccountId" TEXT NOT NULL,
    "lastWebhookAt" TIMESTAMP(3),
    "lastBackfillAt" TIMESTAMP(3),
    "lastIgMessageTimestamp" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngestionCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "seatId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "notifyHighValue" BOOLEAN NOT NULL DEFAULT true,
    "notifyNudge" BOOLEAN NOT NULL DEFAULT true,
    "notifyWeeklySummary" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_clerkUserId_key" ON "User"("clerkUserId");

-- CreateIndex
CREATE INDEX "Seat_orgId_idx" ON "Seat"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Seat_orgId_userId_key" ON "Seat"("orgId", "userId");

-- CreateIndex
CREATE INDEX "IgAccount_orgId_idx" ON "IgAccount"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "IgAccount_platform_igUserId_key" ON "IgAccount"("platform", "igUserId");

-- CreateIndex
CREATE INDEX "Thread_orgId_state_estValueMaxMinor_idx" ON "Thread"("orgId", "state", "estValueMaxMinor" DESC);

-- CreateIndex
CREATE INDEX "Thread_orgId_state_waitingSince_idx" ON "Thread"("orgId", "state", "waitingSince");

-- CreateIndex
CREATE UNIQUE INDEX "Thread_igAccountId_igThreadId_key" ON "Thread"("igAccountId", "igThreadId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_igMessageId_key" ON "Message"("igMessageId");

-- CreateIndex
CREATE INDEX "Message_orgId_threadId_sentAt_idx" ON "Message"("orgId", "threadId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "Classification_messageId_key" ON "Classification"("messageId");

-- CreateIndex
CREATE INDEX "Classification_orgId_routedTo_createdAt_idx" ON "Classification"("orgId", "routedTo", "createdAt");

-- CreateIndex
CREATE INDEX "Classification_orgId_modelVersion_idx" ON "Classification"("orgId", "modelVersion");

-- CreateIndex
CREATE UNIQUE INDEX "Draft_sentMessageId_key" ON "Draft"("sentMessageId");

-- CreateIndex
CREATE INDEX "Draft_orgId_threadId_status_idx" ON "Draft"("orgId", "threadId", "status");

-- CreateIndex
CREATE INDEX "LedgerEntry_orgId_closedAt_idx" ON "LedgerEntry"("orgId", "closedAt");

-- CreateIndex
CREATE UNIQUE INDEX "VoiceProfile_igAccountId_key" ON "VoiceProfile"("igAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "IgnoreListEntry_orgId_handle_key" ON "IgnoreListEntry"("orgId", "handle");

-- CreateIndex
CREATE INDEX "AuditLog_orgId_createdAt_idx" ON "AuditLog"("orgId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_orgId_key" ON "Subscription"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_externalId_key" ON "Subscription"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "IngestionCheckpoint_igAccountId_key" ON "IngestionCheckpoint"("igAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "PushSubscription_orgId_seatId_idx" ON "PushSubscription"("orgId", "seatId");

-- CreateIndex
CREATE INDEX "WebhookEvent_provider_createdAt_idx" ON "WebhookEvent"("provider", "createdAt");

-- AddForeignKey
ALTER TABLE "Seat" ADD CONSTRAINT "Seat_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Seat" ADD CONSTRAINT "Seat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IgAccount" ADD CONSTRAINT "IgAccount_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_igAccountId_fkey" FOREIGN KEY ("igAccountId") REFERENCES "IgAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Classification" ADD CONSTRAINT "Classification_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Classification" ADD CONSTRAINT "Classification_reviewedBySeatId_fkey" FOREIGN KEY ("reviewedBySeatId") REFERENCES "Seat"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Draft" ADD CONSTRAINT "Draft_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Draft" ADD CONSTRAINT "Draft_sentBySeatId_fkey" FOREIGN KEY ("sentBySeatId") REFERENCES "Seat"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Draft" ADD CONSTRAINT "Draft_sentMessageId_fkey" FOREIGN KEY ("sentMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_createdBySeatId_fkey" FOREIGN KEY ("createdBySeatId") REFERENCES "Seat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceProfile" ADD CONSTRAINT "VoiceProfile_igAccountId_fkey" FOREIGN KEY ("igAccountId") REFERENCES "IgAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IgnoreListEntry" ADD CONSTRAINT "IgnoreListEntry_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_seatId_fkey" FOREIGN KEY ("seatId") REFERENCES "Seat"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngestionCheckpoint" ADD CONSTRAINT "IngestionCheckpoint_igAccountId_fkey" FOREIGN KEY ("igAccountId") REFERENCES "IgAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_seatId_fkey" FOREIGN KEY ("seatId") REFERENCES "Seat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

