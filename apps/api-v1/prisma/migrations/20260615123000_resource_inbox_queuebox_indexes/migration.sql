CREATE INDEX resource_inbox_runnable_ix
    ON resource_inbox (ri_type_id, ri_status, expire_ts, next_ts, ri_row_id);

CREATE INDEX resource_inbox_reserved_timeout_ix
    ON resource_inbox (ri_type_id, ri_status, start_ts, expire_ts, ri_row_id);
