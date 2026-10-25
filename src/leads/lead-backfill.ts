import type { PrismaClient } from '../generated/prisma/client.js';

/**
 * Copies the fixed Lead columns into Lead.data (by lead field key) and sets
 * Lead.businessId from the conversation's line, for leads written before
 * Lead.data existed or by the previous release during a deploy. Values
 * already in data win. Idempotent: returns how many leads changed, 0 on a
 * second run. Runs in seed:default-line (pre-deploy); the migration
 * 20261025060000_lead_business_data runs the same statement once.
 */
export async function backfillLeads(prisma: PrismaClient): Promise<number> {
  return prisma.$executeRaw`
    UPDATE lead AS l
    SET business_id = COALESCE(l.business_id, ln.business_id),
        data = jsonb_strip_nulls(jsonb_build_object(
          'name', l.name,
          'business_name', l.business_name,
          'industry', l.industry,
          'need', l.need,
          'contact_notes', l.contact_notes
        )) || l.data
    FROM conversation AS c
    JOIN line AS ln ON ln.id = c.line_id
    WHERE c.id = l.conversation_id
      AND (
        l.business_id IS NULL
        OR (jsonb_strip_nulls(jsonb_build_object(
          'name', l.name,
          'business_name', l.business_name,
          'industry', l.industry,
          'need', l.need,
          'contact_notes', l.contact_notes
        )) || l.data) IS DISTINCT FROM l.data
      )`;
}
