-- Expand only: new nullable columns and a new table; the previous release
-- never reads them.
-- AlterTable
ALTER TABLE "business" ADD COLUMN     "templates_sync_error" TEXT,
ADD COLUMN     "templates_sync_next_at" TIMESTAMP(3),
ADD COLUMN     "templates_synced_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "template" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "waba_id" TEXT NOT NULL,
    "meta_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "components" JSONB NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "template_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "template_business_id_waba_id_name_language_key" ON "template"("business_id", "waba_id", "name", "language");

-- AddForeignKey
ALTER TABLE "template" ADD CONSTRAINT "template_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

