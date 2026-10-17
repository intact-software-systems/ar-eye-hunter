-- The suffix read's reversed-key range replaces a leading-column duplicate of the primary key,
-- so a runtime-state write keeps maintaining five btrees.
DROP INDEX IF EXISTS runtime_state_store_namespace_ix;

CREATE INDEX IF NOT EXISTS runtime_state_store_namespace_reversed_key_c_ix
    ON runtime_state_store (store_namespace, (reverse(store_key)) COLLATE "C");
