-- Prompt 02, step 2: every conversation belongs to a line and a contact.
-- Requires `npm run seed:default-line` to have assigned every existing
-- conversation (it runs in Render's pre-deploy since the previous release).
-- conversation.wa_id is no longer written: it becomes nullable now, so the
-- previous app version (still serving during the pre-deploy step, and still
-- writing it) keeps working, and the next migration drops it.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM conversation WHERE line_id IS NULL OR contact_id IS NULL
  ) THEN
    RAISE EXCEPTION 'conversations without line or contact: run npm run seed:default-line (previous release) before this migration';
  END IF;
END $$;

-- AlterTable
ALTER TABLE "conversation" ALTER COLUMN "wa_id" DROP NOT NULL,
ALTER COLUMN "contact_id" SET NOT NULL,
ALTER COLUMN "line_id" SET NOT NULL;
