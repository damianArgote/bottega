-- Expand only: nullable columns. Media rows keep type UNSUPPORTED (location
-- TEXT), so the previous release reads them as it does today.

-- AlterTable
ALTER TABLE "business" ADD COLUMN "audio_max_seconds" INTEGER,
ADD COLUMN "media_daily_cap_per_conversation" INTEGER;

-- AlterTable
ALTER TABLE "message" ADD COLUMN "media_error" TEXT,
ADD COLUMN "media_filename" TEXT,
ADD COLUMN "media_id" TEXT,
ADD COLUMN "media_kind" TEXT,
ADD COLUMN "media_mime" TEXT,
ADD COLUMN "media_size" INTEGER,
ADD COLUMN "media_voice" BOOLEAN,
ADD COLUMN "transcript" TEXT;

