-- Prompt 12a, deploy 1 of 2 (expand). A business can have several catalogs.
-- The business.catalog_* columns stay (the code on main still reads them)
-- and so does the unique (business_id, external_id) (main upserts by it).
-- Deploy 2 fills catalog_id again, makes it NOT NULL and drops both.
-- One transaction: a failure leaves nothing half done, so a retry works.

BEGIN;


-- CreateEnum
CREATE TYPE "catalog_audience" AS ENUM ('ALL', 'TAGGED');

-- AlterTable
ALTER TABLE "catalog_item" ADD COLUMN     "catalog_id" UUID;

-- AlterTable
ALTER TABLE "catalog_import" ADD COLUMN     "catalog_id" UUID;

-- CreateTable
CREATE TABLE "catalog" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "name_key" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "audience" "catalog_audience" NOT NULL DEFAULT 'ALL',
    "replaces_all" BOOLEAN NOT NULL DEFAULT false,
    "mapping" JSONB,
    "sheet_url" TEXT,
    "sync_next_at" TIMESTAMP(3),
    "synced_at" TIMESTAMP(3),
    "sync_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "catalog_business_id_position_idx" ON "catalog"("business_id", "position");

-- CreateIndex
CREATE INDEX "catalog_sync_next_at_idx" ON "catalog"("sync_next_at");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_business_id_name_key_key" ON "catalog"("business_id", "name_key");

-- CreateIndex
CREATE INDEX "catalog_item_catalog_id_available_idx" ON "catalog_item"("catalog_id", "available");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_item_catalog_id_external_id_key" ON "catalog_item"("catalog_id", "external_id");

-- CreateIndex
CREATE INDEX "catalog_import_catalog_id_created_at_idx" ON "catalog_import"("catalog_id", "created_at");

-- AddForeignKey
ALTER TABLE "catalog_item" ADD CONSTRAINT "catalog_item_catalog_id_fkey" FOREIGN KEY ("catalog_id") REFERENCES "catalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_import" ADD CONSTRAINT "catalog_import_catalog_id_fkey" FOREIGN KEY ("catalog_id") REFERENCES "catalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog" ADD CONSTRAINT "catalog_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Every business with items, imports or a sheet gets its current catalog as
-- "Catálogo principal", with its mapping and its sheet.
INSERT INTO "catalog" ("id", "business_id", "name", "name_key", "position",
  "mapping", "sheet_url", "sync_next_at", "synced_at", "sync_error",
  "created_at", "updated_at")
SELECT gen_random_uuid(), b."id", 'Catálogo principal', 'catalogo principal', 0,
  b."catalog_mapping", b."catalog_sheet_url", b."catalog_sync_next_at",
  b."catalog_synced_at", b."catalog_sync_error",
  (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')
FROM "business" b
WHERE b."catalog_sheet_url" IS NOT NULL
   OR b."catalog_mapping" IS NOT NULL
   OR EXISTS (SELECT 1 FROM "catalog_item" i WHERE i."business_id" = b."id")
   OR EXISTS (SELECT 1 FROM "catalog_import" m WHERE m."business_id" = b."id");

UPDATE "catalog_item" i SET "catalog_id" = c."id"
FROM "catalog" c
WHERE c."business_id" = i."business_id" AND i."catalog_id" IS NULL;

UPDATE "catalog_import" m SET "catalog_id" = c."id"
FROM "catalog" c
WHERE c."business_id" = m."business_id" AND m."catalog_id" IS NULL;

COMMIT;
