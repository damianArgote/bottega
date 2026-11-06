-- Payments (prompt 07c): expand only. Two new tables the current code does not
-- read, and webhook_event.source with a default, so the current code keeps
-- inserting Meta events unchanged.
-- CreateEnum
CREATE TYPE "payment_provider" AS ENUM ('mercadopago', 'transfer');

-- CreateEnum
CREATE TYPE "payment_purpose" AS ENUM ('booking', 'order', 'manual');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'REVIEW');

-- CreateEnum
CREATE TYPE "payment_approver" AS ENUM ('PROVIDER', 'USER');

-- AlterTable
ALTER TABLE "webhook_event" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'whatsapp';

-- CreateTable
CREATE TABLE "payment_account" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "provider" "payment_provider" NOT NULL,
    "label" TEXT NOT NULL,
    "credentials_encrypted" TEXT,
    "webhook_key" TEXT NOT NULL,
    "transfer_alias" TEXT,
    "transfer_holder" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "purpose" "payment_purpose" NOT NULL,
    "purpose_id" TEXT,
    "concept" TEXT NOT NULL,
    "amount_ars" INTEGER NOT NULL,
    "status" "payment_status" NOT NULL DEFAULT 'PENDING',
    "provider_payment_id" TEXT,
    "provider_ref" TEXT,
    "link_url" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "approved_at" TIMESTAMP(3),
    "approved_by" "payment_approver",
    "approved_by_user_id" UUID,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_account_webhook_key_key" ON "payment_account"("webhook_key");

-- CreateIndex
CREATE INDEX "payment_account_business_id_idx" ON "payment_account"("business_id");

-- CreateIndex
CREATE INDEX "payment_conversation_id_created_at_idx" ON "payment"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "payment_status_expires_at_idx" ON "payment"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_business_id_idempotency_key_key" ON "payment"("business_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "payment_account_id_provider_payment_id_key" ON "payment"("account_id", "provider_payment_id");

-- AddForeignKey
ALTER TABLE "payment_account" ADD CONSTRAINT "payment_account_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "payment_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- At most one default account per business (Prisma has no partial unique).
CREATE UNIQUE INDEX "payment_account_one_default_key" ON "payment_account"("business_id") WHERE "is_default";
