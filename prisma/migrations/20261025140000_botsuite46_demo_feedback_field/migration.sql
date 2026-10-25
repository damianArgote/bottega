-- Data change: BotSuite46's agent profile asks what the person thought of
-- the demo (the EXIT_DEMO reply asks it, save_lead stores it as
-- data.demo_feedback). The seed adds the field for new databases; this adds
-- it to an existing profile once (only if missing), raising its version.
-- No schema change: the previous release keeps working.
UPDATE agent_profile AS p
SET lead_fields = p.lead_fields || jsonb_build_array(jsonb_build_object(
      'key', 'demo_feedback',
      'label', 'Qué le pareció la demo (solo si la probó)',
      'required', false,
      'kind', 'text'
    )),
    version = p.version + 1,
    updated_at = now() AT TIME ZONE 'UTC'
FROM business AS b
WHERE b.id = p.business_id
  AND b.slug = 'botsuite46'
  AND jsonb_array_length(p.lead_fields) < 8
  AND NOT p.lead_fields @> '[{"key": "demo_feedback"}]'::jsonb;
