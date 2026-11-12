-- Prompt 12a, deploy 2 of 2 (contract). Runs once 20261112120000_catalogs is
-- on main: the code serving during this deploy always writes catalog_id and
-- no longer reads the business.catalog_* columns nor the old unique.
-- One transaction: a failure leaves nothing half done, so a retry works.

BEGIN;

-- Rows written without a catalog (by the version before deploy 1, while it
-- deployed) go to their business's first catalog, as the code does; a
-- business without any catalog gets "Catálogo principal".
INSERT INTO "catalog" ("id", "business_id", "name", "name_key", "position",
  "created_at", "updated_at")
SELECT gen_random_uuid(), b."id", 'Catálogo principal', 'catalogo principal', 0,
  (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')
FROM "business" b
WHERE NOT EXISTS (SELECT 1 FROM "catalog" c WHERE c."business_id" = b."id")
  AND (EXISTS (SELECT 1 FROM "catalog_item" i
               WHERE i."business_id" = b."id" AND i."catalog_id" IS NULL)
    OR EXISTS (SELECT 1 FROM "catalog_import" m
               WHERE m."business_id" = b."id" AND m."catalog_id" IS NULL));

UPDATE "catalog_item" i SET "catalog_id" = (
  SELECT c."id" FROM "catalog" c WHERE c."business_id" = i."business_id"
  ORDER BY c."position", c."created_at", c."id" LIMIT 1)
WHERE i."catalog_id" IS NULL;

UPDATE "catalog_import" m SET "catalog_id" = (
  SELECT c."id" FROM "catalog" c WHERE c."business_id" = m."business_id"
  ORDER BY c."position", c."created_at", c."id" LIMIT 1)
WHERE m."catalog_id" IS NULL;

-- AlterTable
ALTER TABLE "catalog_item" ALTER COLUMN "catalog_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "catalog_import" ALTER COLUMN "catalog_id" SET NOT NULL;

-- DropIndex: a code can now be in two catalogs of the same business.
DROP INDEX "catalog_item_business_id_external_id_key";

-- The sheet and mapping moved to "catalog" in deploy 1.
ALTER TABLE "business" DROP COLUMN "catalog_mapping",
DROP COLUMN "catalog_sheet_url",
DROP COLUMN "catalog_sync_error",
DROP COLUMN "catalog_sync_next_at",
DROP COLUMN "catalog_synced_at";

COMMIT;
