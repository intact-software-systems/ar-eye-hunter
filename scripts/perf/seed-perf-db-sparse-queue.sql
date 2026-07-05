\timing on

insert into resource_inbox (
    ri_resource_id,
    ri_topic_id,
    ri_resource,
    ri_type_id,
    ri_status,
    fk_ext_bank_id,
    system_date,
    created_by,
    created_ts,
    start_ts,
    next_ts,
    ri_attempts,
    expire_ts
)
select
    substr(md5('perf-sparse-resource-' || g), 1, 32),
    'sparse-topic',
    jsonb_build_object('sequence', g, 'payload', repeat('x', 64))::text,
    'PERF_SPARSE',
    case when g > 99900 then 'NEW' else 'COMPLETED' end,
    'perf-sparse-' || lpad((g % 1000)::text, 4, '0'),
    current_date,
    'perf',
    now() - interval '1 minute',
    null,
    null,
    0,
    now() + interval '1 day'
from generate_series(1, 100000) as g
on conflict do nothing;

ANALYZE resource_inbox;

\echo 'resource_inbox sparse runnable new'
EXPLAIN (ANALYZE, BUFFERS)
SELECT *
FROM resource_inbox
WHERE ri_type_id IN ('PERF_SPARSE')
  AND ri_status IN ('NEW')
  AND expire_ts > now()
  AND (start_ts IS NULL OR next_ts < now())
ORDER BY ri_row_id
LIMIT 100;
