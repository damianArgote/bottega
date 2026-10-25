-- Raw webhook deliveries (prompt 02). Stored after the signature check and
-- before processing; a failed processing stays pending for the reprocessor.

-- The same wa_id may now talk to several lines. Safe to drop here: the
-- previous app version (T2) already upserts ON CONFLICT (line_id, contact_id).
DROP INDEX IF EXISTS "conversation_wa_id_key";

-- CreateTable
CREATE TABLE "webhook_event" (
    "id" BIGSERIAL NOT NULL,
    "line_id" UUID,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "webhook_event_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "webhook_event" ADD CONSTRAINT "webhook_event_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "line"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Written by hand (Prisma cannot model partial indexes): the reprocessor
-- scans pending events oldest first.
-- NOTE: a future `prisma migrate dev` may generate a DROP INDEX for this
-- index because it is not in schema.prisma; remove that line from the
-- generated migration.
CREATE INDEX "webhook_event_pending_received_at_idx"
  ON "webhook_event" ("received_at")
  WHERE "processed_at" IS NULL;
