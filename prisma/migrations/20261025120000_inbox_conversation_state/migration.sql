-- Prompt 04 T1 (expand only): inbox state of conversations, the change
-- cursor (change_txid + version, kept by a trigger) and message.seq for
-- paging. Every new column is nullable or has a default, so the previous
-- release keeps inserting and updating rows; the trigger fills the cursor
-- columns for its writes too.

CREATE TYPE "conversation_status" AS ENUM ('OPEN', 'PENDING', 'RESOLVED');

ALTER TABLE "conversation" ADD COLUMN     "assigned_to_id" UUID,
ADD COLUMN     "change_txid" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "last_message_at" TIMESTAMP(3),
ADD COLUMN     "last_message_preview" VARCHAR(120),
ADD COLUMN     "status" "conversation_status" NOT NULL DEFAULT 'OPEN',
ADD COLUMN     "unread_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "window_expires_at" TIMESTAMP(3);

ALTER TABLE "conversation" ADD CONSTRAINT "conversation_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Change tracking: every insert and update gets the writing transaction's
-- id (the /changes cursor) and raises version. Written by hand: Prisma does
-- not manage triggers. The app never writes these two columns.
CREATE FUNCTION conversation_track_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.change_txid := pg_current_xact_id()::text::bigint;
  IF TG_OP = 'UPDATE' THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := 1;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER conversation_track_change
BEFORE INSERT OR UPDATE ON "conversation"
FOR EACH ROW EXECUTE FUNCTION conversation_track_change();

-- Backfill (the trigger stamps every row with this migration's txid, also
-- conversations without messages):
-- the window from the last inbound message, the last message and its
-- preview, and paused conversations with an open handoff as PENDING.
UPDATE "conversation" SET updated_at = updated_at;  -- stamps every row

UPDATE "conversation" AS c
SET window_expires_at = c.last_inbound_at + interval '24 hours',
    last_message_at = m.created_at,
    -- Same rule as previewOf: one line, at most 120 characters.
    last_message_preview = CASE
      WHEN char_length(m.preview) > 120 THEN left(m.preview, 119) || '…'
      ELSE m.preview
    END,
    status = CASE
      WHEN c.paused AND EXISTS (
        SELECT 1 FROM handoff_request h
        WHERE h.conversation_id = c.id AND h.status = 'OPEN'
      ) THEN 'PENDING'::conversation_status
      ELSE 'OPEN'::conversation_status
    END
FROM (
  SELECT DISTINCT ON (conversation_id) conversation_id, created_at,
    regexp_replace(trim(content), '\s+', ' ', 'g') AS preview
  FROM message
  ORDER BY conversation_id, created_at DESC, id DESC
) AS m
WHERE m.conversation_id = c.id;

-- message.seq: existing rows numbered in creation order, then a sequence
-- (the same name and ownership a BIGSERIAL column gets) for new rows.
ALTER TABLE "message" ADD COLUMN "seq" BIGINT;
UPDATE "message" AS m SET seq = r.n
FROM (
  SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM message
) AS r
WHERE r.id = m.id;
CREATE SEQUENCE "message_seq_seq" OWNED BY "message"."seq";
SELECT setval('message_seq_seq', COALESCE((SELECT max(seq) FROM message), 0) + 1, false);
ALTER TABLE "message" ALTER COLUMN "seq" SET DEFAULT nextval('message_seq_seq'),
ALTER COLUMN "seq" SET NOT NULL;

CREATE INDEX "conversation_line_id_status_last_message_at_idx" ON "conversation"("line_id", "status", "last_message_at" DESC);
CREATE INDEX "conversation_assigned_to_id_status_idx" ON "conversation"("assigned_to_id", "status");
CREATE INDEX "conversation_line_id_change_txid_idx" ON "conversation"("line_id", "change_txid");
CREATE UNIQUE INDEX "message_seq_key" ON "message"("seq");
