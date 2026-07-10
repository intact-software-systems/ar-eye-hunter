DROP INDEX CONCURRENTLY IF EXISTS runtime_state_store_namespace_key_c_ix;

CREATE INDEX CONCURRENTLY runtime_state_store_namespace_key_c_ix
    ON runtime_state_store (store_namespace, store_key COLLATE "C");
