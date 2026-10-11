-- Hand-written migration (Prisma schema cannot express partial indexes).
-- At most one PROCESSING job per conversation: guarantees per-conversation
-- serial processing in the PostgreSQL job queue.
-- NOTE: Prisma does not know about this index. If a future `prisma migrate dev`
-- generates `DROP INDEX "processing_job_one_processing_per_conversation_key"`,
-- remove that statement from the generated migration before applying it.
CREATE UNIQUE INDEX "processing_job_one_processing_per_conversation_key"
  ON "processing_job" ("conversation_id")
  WHERE "status" = 'PROCESSING';
