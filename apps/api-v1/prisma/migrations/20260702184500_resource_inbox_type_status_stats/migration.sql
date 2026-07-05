CREATE STATISTICS IF NOT EXISTS resource_inbox_type_status_stats
    ON ri_type_id, ri_status
    FROM resource_inbox;

ANALYZE resource_inbox;
