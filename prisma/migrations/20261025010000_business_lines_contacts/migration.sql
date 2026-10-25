-- Businesses, lines and contacts (prompt 02, step 1 of 2).
-- conversation.line_id / contact_id stay nullable: `npm run seed:default-line`
-- creates the default business and line and backfills every conversation;
-- a later migration makes them NOT NULL and drops conversation.wa_id.
-- wa_id stops being unique: the same user may talk to several lines.

-- DropIndex
DROP INDEX "conversation_wa_id_key";

-- AlterTable
ALTER TABLE "conversation" ADD COLUMN     "contact_id" UUID,
ADD COLUMN     "line_id" UUID;

-- CreateTable
CREATE TABLE "business" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "bot_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "line" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "phone_number_id" TEXT NOT NULL,
    "waba_id" TEXT,
    "display_phone" TEXT,
    "app_id" TEXT,
    "app_secret_encrypted" TEXT,
    "access_token_encrypted" TEXT,
    "verify_token" TEXT NOT NULL,
    "webhook_key" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "wa_id" TEXT NOT NULL,
    "profile_name" TEXT,
    "name" TEXT,
    "opt_out" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "business_slug_key" ON "business"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "line_phone_number_id_key" ON "line"("phone_number_id");

-- CreateIndex
CREATE UNIQUE INDEX "line_webhook_key_key" ON "line"("webhook_key");

-- CreateIndex
CREATE INDEX "line_business_id_idx" ON "line"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_business_id_wa_id_key" ON "contact"("business_id", "wa_id");

-- CreateIndex
CREATE INDEX "conversation_contact_id_idx" ON "conversation"("contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_line_id_contact_id_key" ON "conversation"("line_id", "contact_id");

-- AddForeignKey
ALTER TABLE "line" ADD CONSTRAINT "line_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact" ADD CONSTRAINT "contact_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

