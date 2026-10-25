-- AlterTable
ALTER TABLE "agent_profile" ADD COLUMN     "updated_by_id" UUID;

-- CreateTable
CREATE TABLE "agent_profile_version" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_profile_version_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_profile_version_business_id_version_key" ON "agent_profile_version"("business_id", "version");

-- AddForeignKey
ALTER TABLE "agent_profile" ADD CONSTRAINT "agent_profile_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_profile_version" ADD CONSTRAINT "agent_profile_version_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_profile_version" ADD CONSTRAINT "agent_profile_version_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill: the current profile of each business is its current version
-- (author unknown), so the history and restore start from it.
INSERT INTO "agent_profile_version" ("id", "business_id", "version", "snapshot", "created_at")
SELECT gen_random_uuid(), "business_id", "version",
  jsonb_build_object(
    'enabled', "enabled",
    'botName', "bot_name",
    'persona', "persona",
    'businessInfo', "business_info",
    'faq', "faq",
    'leadFields', "lead_fields",
    'handoffRules', "handoff_rules",
    'outOfHoursMessage', "out_of_hours_message",
    'openingHours', "opening_hours",
    'model', "model",
    'demoEnabled', "demo_enabled"
  ),
  "updated_at"
FROM "agent_profile";
