-- Leak Scan progress per connected account, so the onboarding reveal can say
-- whether its numbers are final (idle / running / done). Purely additive and
-- nullable; the exact `prisma migrate diff` output for schema.prisma.

-- AlterTable
ALTER TABLE "IgAccount" ADD COLUMN     "leakScanCompletedAt" TIMESTAMP(3),
ADD COLUMN     "leakScanStartedAt" TIMESTAMP(3);
