CREATE INDEX resource_inbox_due_ix
    ON resource_inbox (ri_type_id, ri_status, next_ts NULLS FIRST, ri_row_id);
