-- Business actions (prompt 07b): expand only, two new tables the current code does not read.
-- CreateEnum
CREATE TYPE "agent_action_kind" AS ENUM ('QUERY', 'EFFECT');

-- CreateEnum
CREATE TYPE "agent_action_call_status" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "agent_action" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "parameters" JSONB NOT NULL,
    "url" TEXT NOT NULL,
    "secret_encrypted" TEXT NOT NULL,
    "kind" "agent_action_kind" NOT NULL,
    "timeout_ms" INTEGER NOT NULL DEFAULT 5000,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_action_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_action_call" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "action_id" UUID NOT NULL,
    "conversation_id" UUID,
    "idempotency_key" TEXT NOT NULL,
    "status" "agent_action_call_status" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "response_status" INTEGER,
    "result" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "agent_action_call_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_action_business_id_name_key" ON "agent_action"("business_id", "name");

-- CreateIndex
CREATE INDEX "agent_action_call_business_id_created_at_idx" ON "agent_action_call"("business_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_action_call_action_id_idempotency_key_key" ON "agent_action_call"("action_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "agent_action" ADD CONSTRAINT "agent_action_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_action_call" ADD CONSTRAINT "agent_action_call_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_action_call" ADD CONSTRAINT "agent_action_call_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "agent_action"("id") ON DELETE CASCADE ON UPDATE CASCADE;

