ALTER TABLE "Subscription" ADD COLUMN "lastEventAt" TIMESTAMP(3), ADD COLUMN "lastEventId" TEXT;
CREATE TABLE "BillingEventReceipt" (
  "rail" "BillingRail" NOT NULL,
  "eventId" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BillingEventReceipt_pkey" PRIMARY KEY ("rail", "eventId"),
  CONSTRAINT "BillingEventReceipt_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "BillingEventReceipt_orgId_idx" ON "BillingEventReceipt"("orgId");
