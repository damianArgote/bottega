-- Hand-written migration (Prisma schema cannot express partial indexes).
-- At most one PROCESSING webhook delivery at a time, so a client's endpoint
-- that hangs never takes every worker slot from the bot (QueueService
-- claims accordingly; this index is the last line of defense).
-- NOTE: Prisma does not know about this index. If a future `prisma migrate dev`
-- generates `DROP INDEX "processing_job_one_webhook_processing_key"`, remove
-- that statement from the generated migration before applying it.
CREATE UNIQUE INDEX "processing_job_one_webhook_processing_key"
  ON "processing_job" ("type")
  WHERE "status" = 'PROCESSING' AND "type" = 'WEBHOOK_DELIVERY';
