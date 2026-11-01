-- Expand only: a new job_type value, a nullable column and new tables. The
-- previous release never creates WEBHOOK_DELIVERY jobs; if its worker claims
-- one during a deploy, the job has no message id, the attempt fails as
-- retryable and the new release sends it on a later attempt.
-- AlterEnum
ALTER TYPE "job_type" ADD VALUE 'WEBHOOK_DELIVERY';

-- AlterTable
ALTER TABLE "processing_job" ADD COLUMN     "delivery_id" UUID;

-- CreateTable
CREATE TABLE "webhook_subscription" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "secret_encrypted" TEXT NOT NULL,
    "events" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_success_at" TIMESTAMP(3),
    "last_error_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_delivery" (
    "id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "response_status" INTEGER,
    "last_error" TEXT,
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_key" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_key_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_subscription_business_id_idx" ON "webhook_subscription"("business_id");

-- CreateIndex
CREATE INDEX "webhook_delivery_subscription_id_created_at_idx" ON "webhook_delivery"("subscription_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "integration_key_key_hash_key" ON "integration_key"("key_hash");

-- CreateIndex
CREATE INDEX "integration_key_business_id_idx" ON "integration_key"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "processing_job_delivery_id_key" ON "processing_job"("delivery_id");

-- AddForeignKey
ALTER TABLE "processing_job" ADD CONSTRAINT "processing_job_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "webhook_delivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_subscription" ADD CONSTRAINT "webhook_subscription_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "webhook_subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_key" ADD CONSTRAINT "integration_key_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

