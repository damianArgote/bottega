-- Prompt 02b T5 (expand only): opening hours on the agent profile and the
-- day the out-of-hours notice was last added to a conversation. Both
-- nullable; the previous release does not read them.

-- AlterTable
ALTER TABLE "agent_profile" ADD COLUMN     "opening_hours" JSONB;

-- AlterTable
ALTER TABLE "conversation" ADD COLUMN     "out_of_hours_notice_on" DATE;
