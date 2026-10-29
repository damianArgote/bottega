-- Expand only: new nullable columns, a new table and a new enum value; the
-- previous release never reads them (it never creates document imports).

-- AlterEnum
ALTER TYPE "catalog_import_source" ADD VALUE 'document';

-- AlterTable
ALTER TABLE "business" ADD COLUMN "catalog_mapping" JSONB,
ADD COLUMN "catalog_sheet_url" TEXT,
ADD COLUMN "catalog_sync_error" TEXT,
ADD COLUMN "catalog_sync_next_at" TIMESTAMP(3),
ADD COLUMN "catalog_synced_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "catalog_import" ADD COLUMN "headers" JSONB,
ADD COLUMN "mapping" JSONB,
ADD COLUMN "mapping_confirmed" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "source_records" JSONB;

-- CreateTable
CREATE TABLE "catalog_ai_usage" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "purpose" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "outcome" "ai_outcome" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_ai_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "catalog_ai_usage_business_id_day_idx" ON "catalog_ai_usage"("business_id", "day");

-- AddForeignKey
ALTER TABLE "catalog_ai_usage" ADD CONSTRAINT "catalog_ai_usage_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

