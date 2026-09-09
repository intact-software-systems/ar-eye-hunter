DROP INDEX IF EXISTS resource_inbox_ix;

CREATE INDEX resource_inbox_ix
    ON resource_inbox (ri_status, ri_type_id, created_ts, ri_row_id);
