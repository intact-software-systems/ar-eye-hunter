-- Connect-trigger latches gain their settle instant `notBeforeEpochMs`.
-- Latches written before it existed were satisfied at their plan, so they
-- settle at once; every reader requires the field from here on.
UPDATE runtime_state_store
SET store_value = (store_value::jsonb || '{"notBeforeEpochMs": 0}'::jsonb)::text
WHERE store_namespace = 'group-state:connect-trigger-latches'
  AND NOT (store_value::jsonb ? 'notBeforeEpochMs');
