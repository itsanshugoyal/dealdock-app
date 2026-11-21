-- Invoices from a deal: billing profiles (one per workspace, plus a creator
-- account's own on Roster), invoices with everything they print frozen at
-- issue, per-invoice payments (a deal can now have several Revenue entries:
-- an advance and a balance) and drafts that carry an invoice to the send.
-- The Prisma part is the exact `prisma migrate diff` output from the schema
-- after 202611040001 to this one; the index and CHECK constraints at the end
-- are hand-written, as in earlier migrations.

-- CreateEnum
CREATE TYPE "InvoiceKind" AS ENUM ('full', 'advance', 'balance');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('issued', 'paid', 'void');

-- CreateEnum
CREATE TYPE "SupplyType" AS ENUM ('domestic', 'export_lut', 'export_tax', 'untaxed');

-- DropIndex
DROP INDEX "LedgerEntry_dealId_key";

-- AlterTable
ALTER TABLE "Draft" ADD COLUMN     "invoiceId" TEXT;

-- AlterTable
ALTER TABLE "LedgerEntry" ADD COLUMN     "invoiceId" TEXT;

-- CreateTable
CREATE TABLE "BillingProfile" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "igAccountId" TEXT,
    "legalName" TEXT NOT NULL,
    "addressLines" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "city" TEXT,
    "state" TEXT,
    "country" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "tax" JSONB NOT NULL,
    "pan" TEXT,
    "udyamNumber" TEXT,
    "sacCode" TEXT,
    "payment" JSONB NOT NULL,
    "invoicePrefix" TEXT NOT NULL DEFAULT 'INV',
    "numberYear" TEXT,
    "nextNumber" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "kind" "InvoiceKind" NOT NULL,
    "number" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "supplier" JSONB NOT NULL,
    "billTo" JSONB NOT NULL,
    "lines" JSONB NOT NULL,
    "taxes" JSONB NOT NULL,
    "subtotalMinor" BIGINT NOT NULL,
    "taxMinor" BIGINT NOT NULL,
    "totalMinor" BIGINT NOT NULL,
    "supplyType" "SupplyType" NOT NULL,
    "placeOfSupply" TEXT,
    "notes" TEXT,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'issued',
    "paidAt" TIMESTAMP(3),
    "receivedMinor" BIGINT,
    "tdsMinor" BIGINT,
    "voidedAt" TIMESTAMP(3),
    "createdBySeatId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BillingProfile_igAccountId_key" ON "BillingProfile"("igAccountId");

-- CreateIndex
CREATE INDEX "BillingProfile_orgId_idx" ON "BillingProfile"("orgId");

-- CreateIndex
CREATE INDEX "Invoice_orgId_dealId_idx" ON "Invoice"("orgId", "dealId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_orgId_number_key" ON "Invoice"("orgId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_invoiceId_key" ON "LedgerEntry"("invoiceId");

-- CreateIndex
CREATE INDEX "LedgerEntry_dealId_idx" ON "LedgerEntry"("dealId");

-- AddForeignKey
ALTER TABLE "Draft" ADD CONSTRAINT "Draft_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingProfile" ADD CONSTRAINT "BillingProfile_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingProfile" ADD CONSTRAINT "BillingProfile_igAccountId_fkey" FOREIGN KEY ("igAccountId") REFERENCES "IgAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_createdBySeatId_fkey" FOREIGN KEY ("createdBySeatId") REFERENCES "Seat"("id") ON DELETE SET NULL ON UPDATE CASCADE;



-- One workspace profile per org. PostgreSQL treats NULLs as distinct, so the
-- unique index on "igAccountId" alone would allow several.
CREATE UNIQUE INDEX "BillingProfile_orgId_workspace_key" ON "BillingProfile"("orgId") WHERE "igAccountId" IS NULL;
ALTER TABLE "BillingProfile" ADD CONSTRAINT "BillingProfile_country_iso2" CHECK ("country" ~ '^[A-Z]{2}$');
ALTER TABLE "BillingProfile" ADD CONSTRAINT "BillingProfile_nextNumber_positive" CHECK ("nextNumber" >= 1);

-- Money invariants Prisma does not model (same rules as Deal/LedgerEntry).
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_subtotalMinor_range" CHECK ("subtotalMinor" > 0 AND "subtotalMinor" <= 9007199254740991);
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_taxMinor_range" CHECK ("taxMinor" >= 0 AND "taxMinor" <= 9007199254740991);
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_totalMinor_range" CHECK ("totalMinor" > 0 AND "totalMinor" <= 9007199254740991);
-- Totals add up exactly: no rounding step between the lines and the total.
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_total_adds_up" CHECK ("totalMinor" = "subtotalMinor" + "taxMinor");
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_receivedMinor_range" CHECK ("receivedMinor" IS NULL OR ("receivedMinor" >= 0 AND "receivedMinor" <= 9007199254740991));
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tdsMinor_range" CHECK ("tdsMinor" IS NULL OR ("tdsMinor" >= 0 AND "tdsMinor" <= 9007199254740991));
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_currencyCode_supported" CHECK ("currencyCode" IN ('INR', 'USD', 'GBP', 'EUR', 'AED'));
-- A paid invoice says when it was paid; a void one when it was withdrawn.
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_paid_has_date" CHECK ("status" <> 'paid' OR "paidAt" IS NOT NULL);
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_void_has_date" CHECK ("status" <> 'void' OR "voidedAt" IS NOT NULL);
-- GST allows 16 characters; other countries get a little more room.
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_number_length" CHECK (char_length("number") BETWEEN 1 AND 32);
