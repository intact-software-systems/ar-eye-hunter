\ timing ON \ echo 'runtime_state_store broad prefix' EXPLAIN (ANALYZE, BUFFERS)
SELECT
  store_key,
  store_value
FROM
  runtime_state_store
WHERE
  store_namespace = 'perf-runtime-20260702'
  AND store_key LIKE 'prefix:%'
ORDER BY
  store_key;
\ echo 'runtime_state_store prefix page' EXPLAIN (ANALYZE, BUFFERS)
SELECT
  store_key,
  store_value
FROM
  runtime_state_store
WHERE
  store_namespace = 'perf-runtime-20260702'
  AND store_key LIKE 'prefix:%'
  AND store_key > 'prefix:00090000'
ORDER BY
  store_key
LIMIT
  101;
\ echo 'client_state_events legacy full list' EXPLAIN (ANALYZE, BUFFERS)
SELECT
  event_json
FROM
  client_state_events
WHERE
  application_id = 'perf-app'
  AND workspace_key = 'perf-workspace'
  AND principal_id = 'perf-principal'
ORDER BY
  application_id,
  workspace_key,
  principal_id,
  snapshot_version,
  occurred_at_epoch_ms,
  event_id;
\ echo 'client_state_events paged list' EXPLAIN (ANALYZE, BUFFERS)
SELECT
  event_json
FROM
  client_state_events
WHERE
  application_id = 'perf-app'
  AND workspace_key = 'perf-workspace'
  AND principal_id = 'perf-principal'
  AND (
    snapshot_version > 90000
    OR (
      snapshot_version = 90000
      AND (
        occurred_at_epoch_ms > 1700000090000
        OR (
          occurred_at_epoch_ms = 1700000090000
          AND event_id > 'perf-event-00090000'
        )
      )
    )
  )
ORDER BY
  application_id,
  workspace_key,
  principal_id,
  snapshot_version,
  occurred_at_epoch_ms,
  event_id
LIMIT
  101;
\ echo 'resource_inbox runnable new/retry' EXPLAIN (ANALYZE, BUFFERS)
SELECT
  *
FROM
  resource_inbox
WHERE
  ri_type_id IN ('PERF_TYPE')
  AND ri_status IN ('NEW', 'RETRY')
  AND expire_ts > now()
  AND (
    start_ts IS NULL
    OR next_ts < now()
  )
ORDER BY
  ri_row_id
LIMIT
  100;
\ echo 'resource_inbox reserved timeout' EXPLAIN (ANALYZE, BUFFERS)
SELECT
  *
FROM
  resource_inbox
WHERE
  ri_type_id IN ('PERF_TYPE')
  AND ri_status IN ('RESERVED')
  AND expire_ts > now()
  AND start_ts < now() - interval '1 minute'
ORDER BY
  ri_row_id
LIMIT
  100;
\ echo 'app_data_store broad prefix' EXPLAIN (ANALYZE, BUFFERS)
SELECT
  data_key,
  data_value
FROM
  app_data_store
WHERE
  app_namespace = 'perf-app-20260702'
  AND store_name = 'store'
  AND data_key LIKE 'prefix:%'
ORDER BY
  data_key;
\ echo 'app_data_store broad prefix first page' EXPLAIN (ANALYZE, BUFFERS)
SELECT
  data_key,
  data_value
FROM
  app_data_store
WHERE
  app_namespace = 'perf-app-20260702'
  AND store_name = 'store'
  AND data_key LIKE 'prefix:%'
ORDER BY
  data_key
LIMIT
  1000;
\ echo 'app_data_store broad prefix next page' EXPLAIN (ANALYZE, BUFFERS)
SELECT
  data_key,
  data_value
FROM
  app_data_store
WHERE
  app_namespace = 'perf-app-20260702'
  AND store_name = 'store'
  AND data_key LIKE 'prefix:%'
  AND data_key > 'prefix:00001000'
ORDER BY
  data_key
LIMIT
  1000;
\ echo 'crdt_updates quota byte sum' EXPLAIN (ANALYZE, BUFFERS)
SELECT
  coalesce(sum(octet_length(update_envelope)), 0)
FROM
  crdt_updates
WHERE
  document_key = 'perf-doc-hot';
\ echo 'crdt_updates catch-up page' EXPLAIN (ANALYZE, BUFFERS)
SELECT
  update_envelope
FROM
  crdt_updates
WHERE
  document_key = 'perf-doc-hot'
  AND append_sequence > 90000
ORDER BY
  append_sequence
LIMIT
  500;
