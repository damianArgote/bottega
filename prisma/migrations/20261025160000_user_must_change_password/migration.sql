-- Prompt 05b T1 (expand only): users with a temporary password must change it
-- before using the inbox. The previous release ignores the column.
ALTER TABLE "app_user" ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT false;
