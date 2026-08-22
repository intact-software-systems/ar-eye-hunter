\ timing ON
INSERT INTO
  runtime_state_store (
    store_namespace,
    store_key,
    store_value,
    expire_at_ts
  )
SELECT
  'perf-runtime-20260702',
  'prefix:' || lpad(g::text, 8, '0'),
  jsonb_build_object(
    'kind',
    'runtime',
    'sequence',
    g,
    'payload',
    repeat('x', 512)
  )::text,
  now() + interval '1 day'
FROM
  generate_series(1, 100000) AS g
ON conflict
do nothing
;
INSERT INTO
  app_data_store (
    app_namespace,
    store_name,
    data_key,
    data_value,
    expire_at_ts
  )
SELECT
  'perf-app-20260702',
  'store',
  'prefix:' || lpad(g::text, 8, '0'),
  jsonb_build_object(
    'kind',
    'app-data',
    'sequence',
    g,
    'payload',
    repeat('x', 512)
  )::text,
  now() + interval '1 day'
FROM
  generate_series(1, 50000) AS g
ON conflict
do nothing
;
INSERT INTO
  client_state_events (
    application_id,
    workspace_key,
    principal_id,
    event_id,
    event_type,
    snapshot_version,
    occurred_at_epoch_ms,
    event_json
  )
SELECT
  'perf-app',
  'perf-workspace',
  'perf-principal',
  'perf-event-' || lpad(g::text, 8, '0'),
  CASE
    WHEN g % 5 = 0 THEN 'session-heartbeat'
    ELSE 'principal-updated'
  END,
  g,
  1700000000000 + g,
  jsonb_build_object(
    'eventId',
    'perf-event-' || lpad(g::text, 8, '0'),
    'eventType',
    CASE
      WHEN g % 5 = 0 THEN 'session-heartbeat'
      ELSE 'principal-updated'
    END,
    'snapshotVersion',
    g,
    'occurredAtEpochMs',
    1700000000000 + g,
    'payload',
    repeat('x', 256)
  )::text
FROM
  generate_series(1, 100000) AS g
ON conflict
do nothing
;
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
    next_ts,
    ri_attempts,
    expire_ts
  )
SELECT
  substr(md5('perf-resource-' || g), 1, 32),
  'perf-topic',
  jsonb_build_object('sequence', g, 'payload', repeat('x', 128))::text,
  'PERF_TYPE',
  CASE
    WHEN g % 10 = 0 THEN 'RESERVED'
    WHEN g % 5 = 0 THEN 'RETRY'
    ELSE 'NEW'
  END,
  'perf-bank-' || lpad((g % 1000)::text, 4, '0'),
  CURRENT_DATE,
  'perf',
  now() - interval '1 minute',
  CASE
    WHEN g % 10 = 0 THEN now() - interval '10 minutes'
    ELSE NULL
  END,
  CASE
    WHEN g % 5 = 0 THEN now() - interval '1 minute'
    ELSE NULL
  END,
  CASE
    WHEN g % 5 = 0 THEN 1
    ELSE 0
  END,
  now() + interval '1 day'
FROM
  generate_series(1, 100000) AS g
ON conflict
do nothing
;
INSERT INTO
  crdt_documents (
    document_key,
    application_id,
    workspace_id,
    document_scope,
    document_type,
    document_id,
    document_ref,
    lifecycle,
    last_append_sequence,
    update_count
  )
VALUES
  (
    'perf-doc-hot',
    'perf-app',
    'perf-workspace',
    'workspace',
    'perf-doc',
    'hot',
    'perf-app/perf-workspace/perf-doc/hot',
    'active',
    100000,
    100000
  )
ON conflict
do nothing
;
INSERT INTO
  crdt_updates (
    document_key,
    append_sequence,
    update_id,
    update_envelope,
    accepted_update_hash,
    actor_id,
    principal_id,
    session_id,
    authorization_scope
  )
SELECT
  'perf-doc-hot',
  g,
  'perf-update-' || lpad(g::text, 8, '0'),
  jsonb_build_object(
    'updateId',
    'perf-update-' || lpad(g::text, 8, '0'),
    'sequence',
    g,
    'payload',
    repeat('x', 512)
  )::text,
  md5('perf-update-' || g),
  'actor-' || (g % 50),
  'principal-' || (g % 50),
  'session-' || (g % 50),
  'workspace'
FROM
  generate_series(1, 100000) AS g
ON conflict
do nothing
;
UPDATE
  crdt_documents document
SET
  stored_update_bytes = updates.update_bytes
FROM
  (
    SELECT
      document_key,
      coalesce(sum(octet_length(update_envelope)), 0)::bigint AS update_bytes
    FROM
      crdt_updates
    WHERE
      document_key = 'perf-doc-hot'
    GROUP BY
      document_key
  ) updates
WHERE
  document.document_key = updates.document_key;
