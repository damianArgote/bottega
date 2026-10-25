-- Prompt 02b T7a: Lead.business_id becomes required, and the model stops
-- reading and writing the fixed lead columns (name, business_name,
-- industry, need, contact_notes). The columns stay in the table: the
-- previous release still writes them during this deploy, and Prisma names
-- every column of its model in each query. They are dropped in T7b.
--
-- The previous release always sets business_id and writes data together
-- with the fixed columns, so this last copy only matters for rows from
-- before that release; the fixed columns win for their keys, as before.
UPDATE lead AS l
SET business_id = COALESCE(l.business_id, ln.business_id),
    data = l.data || jsonb_strip_nulls(jsonb_build_object(
      'name', l.name,
      'business_name', l.business_name,
      'industry', l.industry,
      'need', l.need,
      'contact_notes', l.contact_notes
    ))
FROM conversation AS c
JOIN line AS ln ON ln.id = c.line_id
WHERE c.id = l.conversation_id
  AND (
    l.business_id IS NULL
    OR (l.data || jsonb_strip_nulls(jsonb_build_object(
      'name', l.name,
      'business_name', l.business_name,
      'industry', l.industry,
      'need', l.need,
      'contact_notes', l.contact_notes
    ))) IS DISTINCT FROM l.data
  );

-- Fails (and the deploy stops before the new release serves) if any lead
-- still has no business.
ALTER TABLE "lead" ALTER COLUMN "business_id" SET NOT NULL;
