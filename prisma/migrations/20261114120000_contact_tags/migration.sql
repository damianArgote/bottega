-- Prompt 12b (expand only). Contact tags and the catalogs they open:
-- contact_tag (per business), contact_tag_assignment (per contact, valid in
-- all its conversations) and catalog_tag (the tags of a TAGGED catalog).
-- New tables only: the code on main never reads them.
-- One transaction: a failure leaves nothing half done, so a retry works.

BEGIN;
-- CreateEnum
CREATE TYPE "contact_tag_assigner" AS ENUM ('BOT', 'PERSON');

-- CreateTable
CREATE TABLE "contact_tag" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "name_key" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "assigned_by" "contact_tag_assigner" NOT NULL,
    "bot_hint" TEXT,
    "color" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_tag_assignment" (
    "id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "source" "contact_tag_assigner" NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMP(3),
    "removed_by_id" UUID,

    CONSTRAINT "contact_tag_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_tag" (
    "catalog_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,

    CONSTRAINT "catalog_tag_pkey" PRIMARY KEY ("catalog_id","tag_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "contact_tag_business_id_name_key_key" ON "contact_tag"("business_id", "name_key");

-- CreateIndex
CREATE UNIQUE INDEX "contact_tag_business_id_key_key" ON "contact_tag"("business_id", "key");

-- CreateIndex
CREATE INDEX "contact_tag_assignment_tag_id_idx" ON "contact_tag_assignment"("tag_id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_tag_assignment_contact_id_tag_id_key" ON "contact_tag_assignment"("contact_id", "tag_id");

-- CreateIndex
CREATE INDEX "catalog_tag_tag_id_idx" ON "catalog_tag"("tag_id");

-- AddForeignKey
ALTER TABLE "contact_tag" ADD CONSTRAINT "contact_tag_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_tag_assignment" ADD CONSTRAINT "contact_tag_assignment_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_tag_assignment" ADD CONSTRAINT "contact_tag_assignment_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "contact_tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_tag_assignment" ADD CONSTRAINT "contact_tag_assignment_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_tag_assignment" ADD CONSTRAINT "contact_tag_assignment_removed_by_id_fkey" FOREIGN KEY ("removed_by_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_tag" ADD CONSTRAINT "catalog_tag_catalog_id_fkey" FOREIGN KEY ("catalog_id") REFERENCES "catalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_tag" ADD CONSTRAINT "catalog_tag_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "contact_tag"("id") ON DELETE NO ACTION ON UPDATE CASCADE;


COMMIT;
