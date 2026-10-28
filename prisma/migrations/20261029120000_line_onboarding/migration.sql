-- Expand only: the previous release always writes a phone number id and
-- never reads app_published_at, so it keeps working.
ALTER TABLE "line" ALTER COLUMN "phone_number_id" DROP NOT NULL;
ALTER TABLE "line" ADD COLUMN "app_published_at" TIMESTAMP(3);
