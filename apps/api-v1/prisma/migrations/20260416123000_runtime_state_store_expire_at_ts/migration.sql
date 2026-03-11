ALTER TABLE runtime_state_store
    ADD COLUMN expire_at_ts timestamp with time zone NULL;

CREATE INDEX runtime_state_store_namespace_expire_at_ix
    ON runtime_state_store (store_namespace, expire_at_ts);
