-- Prompt 02, last step (contract): the recipient is contact.wa_id. The
-- version on main (previous release) no longer has this column in its Prisma
-- model, so dropping it does not affect it while the pre-deploy step runs.

-- AlterTable
ALTER TABLE "conversation" DROP COLUMN "wa_id";

