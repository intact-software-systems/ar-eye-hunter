CREATE INDEX IF NOT EXISTS runtime_state_store_namespace_reversed_key_c_ix
    ON runtime_state_store (store_namespace, (reverse(store_key)) COLLATE "C");
