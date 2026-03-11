ALTER TABLE runtime_state_store
    ADD COLUMN revision bigint NOT NULL DEFAULT 0;
