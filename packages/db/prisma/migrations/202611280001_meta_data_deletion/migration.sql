-- AlterTable
ALTER TABLE "IgAccount" ADD COLUMN     "metaUserId" TEXT;

-- CreateTable
CREATE TABLE "MetaDeletionRequest" (
    "id" TEXT NOT NULL,
    "confirmationCode" TEXT NOT NULL,
    "metaUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "accountsDeleted" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "MetaDeletionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MetaDeletionRequest_confirmationCode_key" ON "MetaDeletionRequest"("confirmationCode");

-- CreateIndex
CREATE INDEX "MetaDeletionRequest_status_createdAt_idx" ON "MetaDeletionRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "IgAccount_metaUserId_idx" ON "IgAccount"("metaUserId");

