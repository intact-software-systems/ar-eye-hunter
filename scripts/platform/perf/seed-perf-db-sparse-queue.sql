\ timing ON
INSERT INTO
  resource_inbox (
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
SELECT
  substr(md5('perf-sparse-resource-' || g), 1, 32),
  'sparse-topic',
  jsonb_build_object('sequence', g, 'payload', repeat('x', 64))::text,
  'PERF_SPARSE',
  CASE
    WHEN g > 99900 THEN 'NEW'
    WHEN g > 99800 THEN 'RETRY'
    ELSE 'COMPLETED'
  END,
  'perf-sparse-' || lpad((g % 1000)::text, 4, '0'),
  CURRENT_DATE,
  'perf',
  now() - interval '1 minute',
  CASE
    WHEN g BETWEEN 99801 AND 99900 THEN now() - interval '2 minutes'
    ELSE NULL
  END,
  CASE
    WHEN g BETWEEN 99801 AND 99900 THEN now() - interval '1 minute'
    ELSE NULL
  END,
  CASE
    WHEN g BETWEEN 99801 AND 99900 THEN now() - interval '31 seconds'
    ELSE NULL
  END,
  CASE
    WHEN g BETWEEN 99801 AND 99900 THEN 5
    ELSE 0
  END,
  now() + interval '1 day'
FROM
  generate_series(1, 100000) AS g
ON conflict
  (fk_ext_bank_id, ri_resource_id, ri_topic_id)
do UPDATE SET
  ri_status = excluded.ri_status,
  start_ts = excluded.start_ts,
  end_ts = excluded.end_ts,
  next_ts = excluded.next_ts,
  ri_attempts = excluded.ri_attempts,
  expire_ts = excluded.expire_ts;
ANALYZE resource_inbox;
\ echo 'resource_inbox sparse runnable new' EXPLAIN (ANALYZE, BUFFERS)
SELECT
  *
FROM
  resource_inbox
WHERE
  ri_type_id IN ('PERF_SPARSE')
  AND ri_status IN ('NEW')
  AND expire_ts > now()
  AND ri_status <> 'FAILED'
  AND ri_attempts < 20
  AND (
    next_ts IS NULL
    OR next_ts <= now()
  )
ORDER BY
  next_ts ASC NULLS FIRST,
  ri_row_id ASC
LIMIT
  100;
\ echo 'resource_inbox sparse overdue retry fairness lane' EXPLAIN (ANALYZE, BUFFERS)
SELECT
  *
FROM
  resource_inbox
WHERE
  ri_type_id IN ('PERF_SPARSE')
  AND ri_status = 'RETRY'
  AND expire_ts > now()
  AND next_ts <= now() - interval '30 seconds'
  AND ri_attempts < 20
ORDER BY
  next_ts ASC,
  ri_row_id ASC
FOR UPDATE
  SKIP LOCKED
LIMIT
  100;
