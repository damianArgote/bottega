-- Web Push jobs share processing_job (expand: the previous release keeps
-- inserting and claiming INBOUND_MESSAGE jobs as before).

-- CreateEnum
CREATE TYPE "push_reason" AS ENUM ('INBOUND', 'HANDOFF');

-- AlterTable
ALTER TABLE "processing_job" ADD COLUMN "push_reason" "push_reason",
ALTER COLUMN "message_id" DROP NOT NULL;

-- An inbound job always has its message; a push job always has its reason.
ALTER TABLE "processing_job"
  ADD CONSTRAINT "processing_job_inbound_has_message"
    CHECK ("type" <> 'INBOUND_MESSAGE' OR "message_id" IS NOT NULL),
  ADD CONSTRAINT "processing_job_push_has_reason"
    CHECK (("type" = 'PUSH_NOTIFICATION') = ("push_reason" IS NOT NULL));

-- One INBOUND_MESSAGE job per message (the inbound push shares its message).
-- Hand-written partial index: Prisma does not know about it (see
-- 20261011004102_processing_job_single_active).
DROP INDEX "processing_job_message_id_key";
CREATE UNIQUE INDEX "processing_job_inbound_message_key"
  ON "processing_job" ("message_id")
  WHERE "type" = 'INBOUND_MESSAGE';

-- The one-PROCESSING-per-conversation guard is for the bot's jobs only: a
-- push runs beside them.
DROP INDEX "processing_job_one_processing_per_conversation_key";
CREATE UNIQUE INDEX "processing_job_one_processing_per_conversation_key"
  ON "processing_job" ("conversation_id")
  WHERE "status" = 'PROCESSING' AND "type" = 'INBOUND_MESSAGE';
