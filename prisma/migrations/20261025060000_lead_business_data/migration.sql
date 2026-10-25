-- Prompt 02b T3 (expand): leads get their business and a jsonb with the
-- captured values by lead field key. The fixed columns stay (the previous
-- release keeps writing them during the deploy); they are copied into data
-- here and again by backfillLeads (src/leads/lead-backfill.ts) in
-- seed:default-line, and dropped in 02b T7. business_id becomes required then.

-- AlterTable
ALTER TABLE "lead" ADD COLUMN     "business_id" UUID,
ADD COLUMN     "data" JSONB NOT NULL DEFAULT '{}';

-- CreateIndex
CREATE INDEX "lead_business_id_idx" ON "lead"("business_id");

-- AddForeignKey
ALTER TABLE "lead" ADD CONSTRAINT "lead_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: same statement as backfillLeads. Values already in data win.
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
  );
