-- Web Push jobs share processing_job (expand: the previous release keeps
-- inserting and claiming INBOUND_MESSAGE jobs as before).

-- CreateEnum
CREATE TYPE "push_reason" AS ENUM ('INBOUND', 'HANDOFF');

-- A push job has no message_id: a worker of the previous release that
-- claims one fails it (and the queue retries it) instead of taking it for a
-- message to answer. The message a push shows goes in push_message_id.
ALTER TABLE "processing_job" ADD COLUMN "push_reason" "push_reason",
ADD COLUMN "push_message_id" UUID,
ALTER COLUMN "message_id" DROP NOT NULL;

ALTER TABLE "processing_job" ADD CONSTRAINT "processing_job_push_message_id_fkey"
  FOREIGN KEY ("push_message_id") REFERENCES "message"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- An inbound job always has its message; a push job always has its reason
-- and never a message_id.
ALTER TABLE "processing_job"
  ADD CONSTRAINT "processing_job_inbound_has_message"
    CHECK ("type" <> 'INBOUND_MESSAGE' OR "message_id" IS NOT NULL),
  ADD CONSTRAINT "processing_job_push_shape"
    CHECK (("type" = 'PUSH_NOTIFICATION') = ("push_reason" IS NOT NULL)
      AND ("type" <> 'PUSH_NOTIFICATION' OR "message_id" IS NULL));

-- The one-PROCESSING-per-conversation guard is for the bot's jobs only: a
-- push runs beside them. Hand-written partial index (see
-- 20261011004102_processing_job_single_active).
DROP INDEX "processing_job_one_processing_per_conversation_key";
CREATE UNIQUE INDEX "processing_job_one_processing_per_conversation_key"
  ON "processing_job" ("conversation_id")
  WHERE "status" = 'PROCESSING' AND "type" = 'INBOUND_MESSAGE';
