-- Finish drift repairs from the unreleased safety migration.
ALTER TABLE "Classification" ALTER COLUMN "currencyCode" DROP DEFAULT;
DROP INDEX IF EXISTS "IgnoreListEntry_orgId_handle_key";
ALTER TABLE "IgAccount" ADD COLUMN "tokenRefreshedAt" TIMESTAMP(3), ADD COLUMN "tokenExpiresAt" TIMESTAMP(3);

ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_amountMinor_safe" CHECK ("amountMinor" <= 9007199254740991);
ALTER TABLE "Classification" ADD CONSTRAINT "Classification_values_safe" CHECK (
  ("valueMinMinor" IS NULL OR "valueMinMinor" <= 9007199254740991) AND
  ("valueMaxMinor" IS NULL OR "valueMaxMinor" <= 9007199254740991)
);
CREATE FUNCTION freeze_organization_currency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."currencyCode" IS DISTINCT FROM OLD."currencyCode" THEN
    RAISE EXCEPTION 'currency_immutable_for_organization';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Organization_currency_frozen" BEFORE UPDATE ON "Organization"
FOR EACH ROW EXECUTE FUNCTION freeze_organization_currency();
