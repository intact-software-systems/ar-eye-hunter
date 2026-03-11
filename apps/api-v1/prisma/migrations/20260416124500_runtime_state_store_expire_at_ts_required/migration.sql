UPDATE runtime_state_store
SET expire_at_ts = '9999-12-31T23:59:59.999+00:00'
WHERE expire_at_ts IS NULL;

ALTER TABLE runtime_state_store
    ALTER COLUMN expire_at_ts SET NOT NULL;
