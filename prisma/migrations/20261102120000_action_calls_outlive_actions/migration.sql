-- Action calls outlive their action (07b advisories): expand only. action_id
-- becomes nullable (SET NULL on delete), keys get unique per business (they
-- carry the action name) and calls keep a hash of their arguments. The code
-- on main still inserts action_id and reads by (action_id, idempotency_key),
-- which stays unique.
-- DropForeignKey
ALTER TABLE "agent_action_call" DROP CONSTRAINT "agent_action_call_action_id_fkey";

-- AlterTable
ALTER TABLE "agent_action_call" ADD COLUMN     "arguments_hash" TEXT,
ALTER COLUMN "action_id" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "agent_action_call_business_id_idempotency_key_key" ON "agent_action_call"("business_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "agent_action_call" ADD CONSTRAINT "agent_action_call_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "agent_action"("id") ON DELETE SET NULL ON UPDATE CASCADE;

