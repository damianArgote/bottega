-- Expand only: both columns are nullable, so the previous release keeps working.
ALTER TABLE "conversation_context" ADD COLUMN "demo_scenario" TEXT;
ALTER TABLE "demo_request" ADD COLUMN "details" JSONB;
