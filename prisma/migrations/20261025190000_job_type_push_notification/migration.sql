-- Own migration: a new enum value cannot be used in the transaction that
-- adds it.
ALTER TYPE "job_type" ADD VALUE 'PUSH_NOTIFICATION';
