-- CreateEnum
CREATE TYPE "conversation_mode" AS ENUM ('COMMERCIAL', 'DEMO');

-- CreateEnum
CREATE TYPE "context_end_reason" AS ENUM ('RESET', 'MODE_SWITCH');

-- CreateEnum
CREATE TYPE "message_direction" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "message_type" AS ENUM ('TEXT', 'UNSUPPORTED', 'SYSTEM');

-- CreateEnum
CREATE TYPE "message_status" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'UNCERTAIN');

-- CreateEnum
CREATE TYPE "message_author" AS ENUM ('BOT', 'HUMAN', 'USER');

-- CreateEnum
CREATE TYPE "lead_status" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "handoff_status" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "job_type" AS ENUM ('INBOUND_MESSAGE');

-- CreateEnum
CREATE TYPE "job_status" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ai_outcome" AS ENUM ('OK', 'ERROR', 'LIMITED');

-- CreateTable
CREATE TABLE "conversation" (
    "id" UUID NOT NULL,
    "wa_id" TEXT NOT NULL,
    "mode" "conversation_mode" NOT NULL DEFAULT 'COMMERCIAL',
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "paused_at" TIMESTAMP(3),
    "active_context_id" UUID,
    "last_inbound_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_context" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "mode" "conversation_mode" NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "end_reason" "context_end_reason",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_context_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "context_id" UUID,
    "wa_message_id" TEXT,
    "direction" "message_direction" NOT NULL,
    "type" "message_type" NOT NULL,
    "content" TEXT NOT NULL,
    "status" "message_status" NOT NULL,
    "idempotency_key" TEXT,
    "author" "message_author" NOT NULL,
    "error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "name" TEXT,
    "business_name" TEXT,
    "industry" TEXT,
    "need" TEXT,
    "contact_notes" TEXT,
    "status" "lead_status" NOT NULL DEFAULT 'NEW',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "demo_request" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "context_id" UUID NOT NULL,
    "scenario" TEXT NOT NULL,
    "customer_name" TEXT,
    "service" TEXT,
    "preferred_date" TEXT,
    "preferred_time" TEXT,
    "notes" TEXT,
    "is_fictitious" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "demo_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "handoff_request" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "reason" TEXT,
    "status" "handoff_status" NOT NULL DEFAULT 'OPEN',
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "handoff_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processing_job" (
    "id" UUID NOT NULL,
    "type" "job_type" NOT NULL,
    "conversation_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "status" "job_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL,
    "run_after" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_expires_at" TIMESTAMP(3),
    "locked_by" TEXT,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "processing_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "model" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "outcome" "ai_outcome" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conversation_wa_id_key" ON "conversation"("wa_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_active_context_id_key" ON "conversation"("active_context_id");

-- CreateIndex
CREATE INDEX "conversation_context_conversation_id_started_at_idx" ON "conversation_context"("conversation_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "message_wa_message_id_key" ON "message"("wa_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_idempotency_key_key" ON "message"("idempotency_key");

-- CreateIndex
CREATE INDEX "message_context_id_created_at_idx" ON "message"("context_id", "created_at");

-- CreateIndex
CREATE INDEX "message_conversation_id_created_at_idx" ON "message"("conversation_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "lead_conversation_id_key" ON "lead"("conversation_id");

-- CreateIndex
CREATE INDEX "demo_request_conversation_id_created_at_idx" ON "demo_request"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "handoff_request_status_created_at_idx" ON "handoff_request"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "processing_job_message_id_key" ON "processing_job"("message_id");

-- CreateIndex
CREATE INDEX "processing_job_status_run_after_idx" ON "processing_job"("status", "run_after");

-- CreateIndex
CREATE INDEX "processing_job_conversation_id_created_at_idx" ON "processing_job"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_usage_conversation_id_day_idx" ON "ai_usage"("conversation_id", "day");

-- AddForeignKey
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_active_context_id_fkey" FOREIGN KEY ("active_context_id") REFERENCES "conversation_context"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_context" ADD CONSTRAINT "conversation_context_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_context_id_fkey" FOREIGN KEY ("context_id") REFERENCES "conversation_context"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead" ADD CONSTRAINT "lead_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "demo_request" ADD CONSTRAINT "demo_request_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "demo_request" ADD CONSTRAINT "demo_request_context_id_fkey" FOREIGN KEY ("context_id") REFERENCES "conversation_context"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handoff_request" ADD CONSTRAINT "handoff_request_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_job" ADD CONSTRAINT "processing_job_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_job" ADD CONSTRAINT "processing_job_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
