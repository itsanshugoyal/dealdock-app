-- Redesign: drafts that learn, offers, sender context, voice notes in/out.
-- Purely additive (docs/redesign/00-decisions.md section 3). The first part
-- is the exact `prisma migrate diff` output for schema.prisma; backfills and
-- CHECK constraints (which Prisma does not model, so they cannot drift)
-- follow at the end, the same pattern as 202610260001_safety_invariants.
-- Every new org-owned table cascades from "Organization" so privacy deletion
-- and the deletion drill stay complete.

-- CreateEnum
CREATE TYPE "MessageOrigin" AS ENUM ('native', 'dealdock', 'automation');

-- CreateEnum
CREATE TYPE "VoiceRuleStatus" AS ENUM ('candidate', 'active', 'pinned', 'muted');

-- CreateEnum
CREATE TYPE "VoiceRuleSource" AS ENUM ('samples', 'edits', 'feedback', 'user');

-- CreateEnum
CREATE TYPE "SpeakingVoiceStatus" AS ENUM ('pending', 'ready', 'failed', 'revoked');

-- CreateEnum
CREATE TYPE "AudioAssetKind" AS ENUM ('voice_sample', 'consent', 'tts', 'inbound');

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "monthlyGoalMinor" BIGINT;

-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "participantAvatarUrl" TEXT,
ADD COLUMN     "participantFollowerCount" INTEGER,
ADD COLUMN     "participantFollowsYou" BOOLEAN,
ADD COLUMN     "participantName" TEXT,
ADD COLUMN     "participantVerified" BOOLEAN,
ADD COLUMN     "profileFetchedAt" TIMESTAMP(3),
ADD COLUMN     "source" TEXT;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "audioAssetId" TEXT,
ADD COLUMN     "durationMs" INTEGER,
ADD COLUMN     "mediaStatus" TEXT,
ADD COLUMN     "origin" "MessageOrigin",
ADD COLUMN     "transcript" TEXT,
ADD COLUMN     "transcriptLanguage" TEXT;

-- AlterTable
ALTER TABLE "Draft" ADD COLUMN     "alternatives" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "chips" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "chosenAlternative" INTEGER,
ADD COLUMN     "editRatio" DOUBLE PRECISION,
ADD COLUMN     "editSignals" JSONB,
ADD COLUMN     "generationContext" JSONB,
ADD COLUMN     "instruction" TEXT,
ADD COLUMN     "label" "ClassificationLabel",
ADD COLUMN     "learnedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "VoiceProfile" ADD COLUMN     "excludedMessageIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "lastDistilledAt" TIMESTAMP(3),
ADD COLUMN     "learningPaused" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "styleOverrides" JSONB;

-- AlterTable
ALTER TABLE "SendIntent" ADD COLUMN     "asVoice" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "audioAssetId" TEXT;

-- CreateTable
CREATE TABLE "VoiceRule" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "igAccountId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'all',
    "status" "VoiceRuleStatus" NOT NULL DEFAULT 'candidate',
    "source" "VoiceRuleSource" NOT NULL,
    "evidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "against" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "distinctDrafts" INTEGER NOT NULL DEFAULT 0,
    "distinctThreads" INTEGER NOT NULL DEFAULT 0,
    "creatorEvidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "examples" JSONB NOT NULL DEFAULT '[]',
    "lastEvidenceAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoiceRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DraftFeedback" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "seatId" TEXT,
    "chips" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DraftFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Offer" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "igAccountId" TEXT,
    "name" TEXT NOT NULL,
    "dealType" "DealType" NOT NULL,
    "priceMinMinor" BIGINT,
    "priceMaxMinor" BIGINT,
    "currencyCode" TEXT NOT NULL,
    "link" TEXT,
    "details" TEXT,
    "availability" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpeakingVoice" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "igAccountId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalVoiceId" TEXT,
    "status" "SpeakingVoiceStatus" NOT NULL DEFAULT 'pending',
    "consentStatement" TEXT NOT NULL,
    "consentedAt" TIMESTAMP(3) NOT NULL,
    "consentSeatId" TEXT,
    "disclosureEnabled" BOOLEAN NOT NULL DEFAULT true,
    "sampleSeconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sampleAssetIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastError" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpeakingVoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudioAsset" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" "AudioAssetKind" NOT NULL,
    "mimeType" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "durationMs" INTEGER,
    "text" TEXT,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "AudioAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VoiceRule_orgId_igAccountId_status_idx" ON "VoiceRule"("orgId", "igAccountId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "VoiceRule_igAccountId_key_scope_key" ON "VoiceRule"("igAccountId", "key", "scope");

-- CreateIndex
CREATE INDEX "DraftFeedback_orgId_draftId_idx" ON "DraftFeedback"("orgId", "draftId");

-- CreateIndex
CREATE INDEX "Offer_orgId_active_idx" ON "Offer"("orgId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "SpeakingVoice_igAccountId_key" ON "SpeakingVoice"("igAccountId");

-- CreateIndex
CREATE INDEX "AudioAsset_orgId_kind_createdAt_idx" ON "AudioAsset"("orgId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "AudioAsset_expiresAt_idx" ON "AudioAsset"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_audioAssetId_key" ON "Message"("audioAssetId");

-- CreateIndex
CREATE INDEX "Message_orgId_direction_origin_sentAt_idx" ON "Message"("orgId", "direction", "origin", "sentAt");

-- CreateIndex
CREATE INDEX "Draft_orgId_status_sentAt_idx" ON "Draft"("orgId", "status", "sentAt");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_audioAssetId_fkey" FOREIGN KEY ("audioAssetId") REFERENCES "AudioAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceRule" ADD CONSTRAINT "VoiceRule_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceRule" ADD CONSTRAINT "VoiceRule_igAccountId_fkey" FOREIGN KEY ("igAccountId") REFERENCES "IgAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftFeedback" ADD CONSTRAINT "DraftFeedback_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftFeedback" ADD CONSTRAINT "DraftFeedback_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "Draft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftFeedback" ADD CONSTRAINT "DraftFeedback_seatId_fkey" FOREIGN KEY ("seatId") REFERENCES "Seat"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_igAccountId_fkey" FOREIGN KEY ("igAccountId") REFERENCES "IgAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpeakingVoice" ADD CONSTRAINT "SpeakingVoice_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpeakingVoice" ADD CONSTRAINT "SpeakingVoice_igAccountId_fkey" FOREIGN KEY ("igAccountId") REFERENCES "IgAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpeakingVoice" ADD CONSTRAINT "SpeakingVoice_consentSeatId_fkey" FOREIGN KEY ("consentSeatId") REFERENCES "Seat"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioAsset" ADD CONSTRAINT "AudioAsset_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Backfills (research 04 section 3).
-- ---------------------------------------------------------------------------

-- Provenance: outbound messages sent through the human send gate are
-- "dealdock"; every other outbound message was typed natively in Instagram.
-- Untouched DealDock drafts must never be learned from as the creator's voice.
UPDATE "Message" m
SET "origin" = 'dealdock'
WHERE m."direction" = 'outbound'
  AND (
    EXISTS (SELECT 1 FROM "Draft" d WHERE d."sentMessageId" = m."id")
    OR EXISTS (
      SELECT 1 FROM "SendIntent" s
      WHERE s."orgId" = m."orgId" AND s."platformMessageId" = m."igMessageId"
    )
  );
UPDATE "Message" SET "origin" = 'native'
WHERE "direction" = 'outbound' AND "origin" IS NULL;

-- The label a draft was written for: the (reviewed) classification of the
-- message it replies to, else the thread's denormalized top label.
UPDATE "Draft" d
SET "label" = COALESCE(
  (
    SELECT CASE
      WHEN c."reviewOutcome" = 'overridden' AND c."overrideLabel" IS NOT NULL THEN c."overrideLabel"
      ELSE c."label"
    END
    FROM "Classification" c
    WHERE c."messageId" = d."replyToMessageId"
  ),
  (SELECT t."topLabel" FROM "Thread" t WHERE t."id" = d."threadId")
)
WHERE d."label" IS NULL;

-- editRatio = min(1, editDistance / draft length), as @dealdock/core
-- editRatio(). char_length counts code points while JS counts UTF-16 units,
-- so astral characters (emoji) can make this marginally high; LEAST clamps.
UPDATE "Draft"
SET "editRatio" = CASE
  WHEN char_length("body") = 0 THEN
    CASE WHEN char_length(COALESCE("finalText", '')) = 0 THEN 0 ELSE 1 END
  ELSE LEAST(1.0, "editDistance"::DOUBLE PRECISION / char_length("body"))
END
WHERE "editDistance" IS NOT NULL AND "editRatio" IS NULL;

-- ---------------------------------------------------------------------------
-- Database-level guards (not modelled by Prisma, so they never drift).
-- ---------------------------------------------------------------------------

ALTER TABLE "Organization"
  ADD CONSTRAINT "Organization_monthlyGoalMinor_nonnegative"
  CHECK ("monthlyGoalMinor" IS NULL OR "monthlyGoalMinor" >= 0);

ALTER TABLE "Thread"
  ADD CONSTRAINT "Thread_participantFollowerCount_nonnegative"
  CHECK ("participantFollowerCount" IS NULL OR "participantFollowerCount" >= 0),
  ADD CONSTRAINT "Thread_source_known"
  CHECK ("source" IS NULL OR "source" IN ('dm', 'story', 'reel', 'ad', 'link'));

ALTER TABLE "Message"
  ADD CONSTRAINT "Message_origin_outbound_only"
  CHECK ("origin" IS NULL OR "direction" = 'outbound'),
  ADD CONSTRAINT "Message_mediaStatus_known"
  CHECK ("mediaStatus" IS NULL OR "mediaStatus" IN ('pending', 'ready', 'unavailable', 'failed')),
  ADD CONSTRAINT "Message_durationMs_nonnegative"
  CHECK ("durationMs" IS NULL OR "durationMs" >= 0);

ALTER TABLE "Draft"
  ADD CONSTRAINT "Draft_editRatio_range"
  CHECK ("editRatio" IS NULL OR ("editRatio" >= 0 AND "editRatio" <= 1)),
  ADD CONSTRAINT "Draft_chosenAlternative_nonnegative"
  CHECK ("chosenAlternative" IS NULL OR "chosenAlternative" >= 0);

ALTER TABLE "VoiceRule"
  ADD CONSTRAINT "VoiceRule_evidence_nonnegative"
  CHECK (
    "evidence" >= 0 AND "against" >= 0 AND "creatorEvidence" >= 0 AND
    "distinctDrafts" >= 0 AND "distinctThreads" >= 0
  );

ALTER TABLE "Offer"
  ADD CONSTRAINT "Offer_currencyCode_supported"
  CHECK ("currencyCode" IN ('INR', 'USD', 'GBP', 'EUR', 'AED')),
  ADD CONSTRAINT "Offer_price_range"
  CHECK (
    ("priceMinMinor" IS NULL OR "priceMinMinor" >= 0) AND
    ("priceMaxMinor" IS NULL OR "priceMaxMinor" >= 0) AND
    ("priceMinMinor" IS NULL OR "priceMaxMinor" IS NULL OR "priceMinMinor" <= "priceMaxMinor")
  );

ALTER TABLE "SpeakingVoice"
  ADD CONSTRAINT "SpeakingVoice_sampleSeconds_nonnegative"
  CHECK ("sampleSeconds" >= 0);

-- Instagram's audio attachment cap is 25 MB (26214400 bytes); nothing larger
-- is ever stored, whatever a future caller claims in sizeBytes.
ALTER TABLE "AudioAsset"
  ADD CONSTRAINT "AudioAsset_size_cap"
  CHECK (
    "sizeBytes" >= 0 AND "sizeBytes" <= 26214400 AND
    octet_length("bytes") <= 26214400
  ),
  ADD CONSTRAINT "AudioAsset_durationMs_nonnegative"
  CHECK ("durationMs" IS NULL OR "durationMs" >= 0);
