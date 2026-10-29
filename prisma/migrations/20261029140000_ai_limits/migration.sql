-- Expand only: the previous release never reads the columns, and null keeps
-- every business on the environment defaults.
ALTER TABLE "business" ADD COLUMN "ai_monthly_cap" INTEGER,
ADD COLUMN "ai_daily_cap_per_conversation" INTEGER;

-- The business's monthly AI count filters ai_usage by day range.
CREATE INDEX "ai_usage_day_idx" ON "ai_usage"("day");
