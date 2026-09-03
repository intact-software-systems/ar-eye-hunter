-- Connect-trigger latches gain the candidate they wait to see replaced.
-- Latches written before it existed were armed by a `plan`, which names no
-- candidate, so they carry null; every reader requires the field from here on.
UPDATE runtime_state_store
SET store_value = (store_value::jsonb || '{"supersedesLayoutIdentity": null}'::jsonb)::text
WHERE store_namespace = 'group-state:connect-trigger-latches'
  AND NOT (store_value::jsonb ? 'supersedesLayoutIdentity');
