-- Reply buttons sent under a bot message (expand only: nullable, the
-- previous release ignores it).
ALTER TABLE "message" ADD COLUMN "buttons" JSONB;
