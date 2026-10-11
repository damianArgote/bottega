-- Monotonic enqueue order for per-conversation FIFO processing.
-- AlterTable
ALTER TABLE "processing_job" ADD COLUMN     "seq" BIGSERIAL NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "processing_job_seq_key" ON "processing_job"("seq");
