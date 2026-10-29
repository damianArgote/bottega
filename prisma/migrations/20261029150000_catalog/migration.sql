-- Expand only: new tables and a nullable column; the previous release never
-- reads them.

-- Accent-insensitive Spanish search (Neon supports both extensions).
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TEXT SEARCH CONFIGURATION public.spanish_unaccent (COPY = pg_catalog.spanish);
ALTER TEXT SEARCH CONFIGURATION public.spanish_unaccent
  ALTER MAPPING FOR hword, hword_part, word WITH unaccent, spanish_stem;

-- CreateEnum
CREATE TYPE "catalog_import_source" AS ENUM ('csv', 'api', 'sheet');

-- CreateEnum
CREATE TYPE "catalog_import_status" AS ENUM ('PREVIEW', 'APPLIED', 'DISCARDED');

-- AlterTable
ALTER TABLE "business" ADD COLUMN     "catalog_item_cap" INTEGER;

-- CreateTable
CREATE TABLE "catalog_item" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "category" TEXT,
    "price" DECIMAL(12,2),
    "currency" TEXT NOT NULL DEFAULT 'ARS',
    "available" BOOLEAN NOT NULL DEFAULT true,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "row_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalog_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_import" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "source" "catalog_import_source" NOT NULL,
    "status" "catalog_import_status" NOT NULL DEFAULT 'PREVIEW',
    "summary" JSONB NOT NULL,
    "row_errors" JSONB NOT NULL DEFAULT '[]',
    "rows" JSONB,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_at" TIMESTAMP(3),

    CONSTRAINT "catalog_import_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "catalog_item_business_id_available_idx" ON "catalog_item"("business_id", "available");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_item_business_id_external_id_key" ON "catalog_item"("business_id", "external_id");

-- CreateIndex
CREATE INDEX "catalog_import_business_id_created_at_idx" ON "catalog_import"("business_id", "created_at");

-- AddForeignKey
ALTER TABLE "catalog_item" ADD CONSTRAINT "catalog_item_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_import" ADD CONSTRAINT "catalog_import_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_import" ADD CONSTRAINT "catalog_import_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Full-text search (name A, category B, description C), kept by Postgres.
-- Prisma declares it as Unsupported("tsvector") and never writes it.
ALTER TABLE "catalog_item" ADD COLUMN "search" tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('public.spanish_unaccent', "name"), 'A') ||
  setweight(to_tsvector('public.spanish_unaccent', coalesce("category", '')), 'B') ||
  setweight(to_tsvector('public.spanish_unaccent', "description"), 'C')
) STORED;
CREATE INDEX "catalog_item_search_idx" ON "catalog_item" USING GIN ("search");

-- Typo-tolerant name search ("chocolate amrgo").
CREATE INDEX "catalog_item_name_trgm_idx" ON "catalog_item" USING GIN ("name" gin_trgm_ops);
