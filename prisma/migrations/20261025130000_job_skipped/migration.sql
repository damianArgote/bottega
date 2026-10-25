-- Prompt 04 T2 (expand only): jobs that end without a reply because a person
-- attends the conversation (or the bot is paused). Only the new release
-- writes this value. A rollback to an earlier release would fail to read
-- SKIPPED jobs through Prisma: mark them COMPLETED first
-- (UPDATE processing_job SET status = 'COMPLETED' WHERE status = 'SKIPPED').
ALTER TYPE "job_status" ADD VALUE 'SKIPPED';
