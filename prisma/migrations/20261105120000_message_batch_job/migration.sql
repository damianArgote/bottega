-- Expand only: the previous release neither reads nor writes this column.
-- The job that answers a message together with the one that created it.
ALTER TABLE "message" ADD COLUMN "batch_job_id" UUID;

CREATE INDEX "message_batch_job_id_idx" ON "message"("batch_job_id");

ALTER TABLE "message" ADD CONSTRAINT "message_batch_job_id_fkey" FOREIGN KEY ("batch_job_id") REFERENCES "processing_job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
