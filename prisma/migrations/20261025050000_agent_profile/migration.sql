-- Prompt 02b T1 (expand only): agent profiles, business timezone and the
-- profile version on AI usage. Nothing reads them yet, so the previous
-- release keeps working while this runs in pre-deploy.

-- AlterTable
ALTER TABLE "ai_usage" ADD COLUMN     "agent_profile_version" INTEGER;

-- AlterTable
ALTER TABLE "business" ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'America/Argentina/Buenos_Aires';

-- CreateTable
CREATE TABLE "agent_profile" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "bot_name" TEXT NOT NULL,
    "persona" TEXT NOT NULL DEFAULT '',
    "business_info" TEXT NOT NULL DEFAULT '',
    "faq" JSONB NOT NULL DEFAULT '[]',
    "lead_fields" JSONB NOT NULL DEFAULT '[]',
    "handoff_rules" TEXT NOT NULL DEFAULT '',
    "out_of_hours_message" TEXT,
    "model" TEXT,
    "demo_enabled" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_profile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_profile_business_id_key" ON "agent_profile"("business_id");

-- AddForeignKey
ALTER TABLE "agent_profile" ADD CONSTRAINT "agent_profile_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
