-- Prompt 02b T7b (contract): drops the fixed lead columns. Since T7a no
-- release reads or writes them (the Prisma model no longer has them), and
-- data holds every value. The copy below only fills keys still missing from
-- data; data wins, because the columns stopped being updated in T7a.
UPDATE lead
SET data = jsonb_strip_nulls(jsonb_build_object(
      'name', name,
      'business_name', business_name,
      'industry', industry,
      'need', need,
      'contact_notes', contact_notes
    )) || data
WHERE (jsonb_strip_nulls(jsonb_build_object(
      'name', name,
      'business_name', business_name,
      'industry', industry,
      'need', need,
      'contact_notes', contact_notes
    )) || data) IS DISTINCT FROM data;

ALTER TABLE "lead" DROP COLUMN "business_name",
DROP COLUMN "contact_notes",
DROP COLUMN "industry",
DROP COLUMN "name",
DROP COLUMN "need";
