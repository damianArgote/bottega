-- Expand only: the previous release never reads the column, and the default
-- keeps every existing user without the staff role.
ALTER TABLE "app_user" ADD COLUMN "staff" BOOLEAN NOT NULL DEFAULT false;
