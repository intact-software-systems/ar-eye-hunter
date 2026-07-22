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
    end_ts,
    next_ts,
    ri_attempts,
    expire_ts
)
select
    substr(md5('perf-sparse-resource-' || g), 1, 32),
    'sparse-topic',
    jsonb_build_object('sequence', g, 'payload', repeat('x', 64))::text,
    'PERF_SPARSE',
    case
        when g > 99900 then 'NEW'
        when g > 99800 then 'RETRY'
        else 'COMPLETED'
        end,
    'perf-sparse-' || lpad((g % 1000)::text, 4, '0'),
    current_date,
    'perf',
    now() - interval '1 minute',
    case when g between 99801 and 99900 then now() - interval '2 minutes' else null end,
    case when g between 99801 and 99900 then now() - interval '1 minute' else null end,
    case when g between 99801 and 99900 then now() - interval '31 seconds' else null end,
    case when g between 99801 and 99900 then 5 else 0 end,
    now() + interval '1 day'
from generate_series(1, 100000) as g
on conflict (fk_ext_bank_id, ri_resource_id, ri_topic_id) do update
set ri_status = excluded.ri_status,
    start_ts = excluded.start_ts,
    end_ts = excluded.end_ts,
    next_ts = excluded.next_ts,
    ri_attempts = excluded.ri_attempts,
    expire_ts = excluded.expire_ts;

ANALYZE resource_inbox;

\echo 'resource_inbox sparse runnable new'
EXPLAIN (ANALYZE, BUFFERS)
SELECT *
FROM resource_inbox
WHERE ri_type_id IN ('PERF_SPARSE')
  AND ri_status IN ('NEW')
  AND expire_ts > now()
  AND ri_status <> 'FAILED'
  AND ri_attempts < 20
  AND (next_ts IS NULL OR next_ts <= now())
ORDER BY next_ts ASC NULLS FIRST, ri_row_id ASC
LIMIT 100;

\echo 'resource_inbox sparse overdue retry fairness lane'
EXPLAIN (ANALYZE, BUFFERS)
SELECT *
FROM resource_inbox
WHERE ri_type_id IN ('PERF_SPARSE')
  AND ri_status = 'RETRY'
  AND expire_ts > now()
  AND next_ts <= now() - interval '30 seconds'
  AND ri_attempts < 20
ORDER BY next_ts ASC, ri_row_id ASC
FOR UPDATE SKIP LOCKED
LIMIT 100;
