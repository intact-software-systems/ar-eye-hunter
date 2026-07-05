\timing on

insert into runtime_state_store (
    store_namespace,
    store_key,
    store_value,
    expire_at_ts
)
select
    'perf-runtime-20260702',
    'prefix:' || lpad(g::text, 8, '0'),
    jsonb_build_object(
        'kind', 'runtime',
        'sequence', g,
        'payload', repeat('x', 512)
    )::text,
    now() + interval '1 day'
from generate_series(1, 100000) as g
on conflict do nothing;

insert into app_data_store (
    app_namespace,
    store_name,
    data_key,
    data_value,
    expire_at_ts
)
select
    'perf-app-20260702',
    'store',
    'prefix:' || lpad(g::text, 8, '0'),
    jsonb_build_object(
        'kind', 'app-data',
        'sequence', g,
        'payload', repeat('x', 512)
    )::text,
    now() + interval '1 day'
from generate_series(1, 50000) as g
on conflict do nothing;

insert into client_state_events (
    application_id,
    workspace_key,
    principal_id,
    event_id,
    event_type,
    snapshot_version,
    occurred_at_epoch_ms,
    event_json
)
select
    'perf-app',
    'perf-workspace',
    'perf-principal',
    'perf-event-' || lpad(g::text, 8, '0'),
    case when g % 5 = 0 then 'session-heartbeat' else 'principal-updated' end,
    g,
    1700000000000 + g,
    jsonb_build_object(
        'eventId', 'perf-event-' || lpad(g::text, 8, '0'),
        'eventType', case when g % 5 = 0 then 'session-heartbeat' else 'principal-updated' end,
        'snapshotVersion', g,
        'occurredAtEpochMs', 1700000000000 + g,
        'payload', repeat('x', 256)
    )::text
from generate_series(1, 100000) as g
on conflict do nothing;

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
    substr(md5('perf-resource-' || g), 1, 32),
    'perf-topic',
    jsonb_build_object('sequence', g, 'payload', repeat('x', 128))::text,
    'PERF_TYPE',
    case
        when g % 10 = 0 then 'RESERVED'
        when g % 5 = 0 then 'RETRY'
        else 'NEW'
    end,
    'perf-bank-' || lpad((g % 1000)::text, 4, '0'),
    current_date,
    'perf',
    now() - interval '1 minute',
    case when g % 10 = 0 then now() - interval '10 minutes' else null end,
    case when g % 5 = 0 then now() - interval '1 minute' else null end,
    case when g % 5 = 0 then 1 else 0 end,
    now() + interval '1 day'
from generate_series(1, 100000) as g
on conflict do nothing;

insert into crdt_documents (
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
values (
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
on conflict do nothing;

insert into crdt_updates (
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
select
    'perf-doc-hot',
    g,
    'perf-update-' || lpad(g::text, 8, '0'),
    jsonb_build_object(
        'updateId', 'perf-update-' || lpad(g::text, 8, '0'),
        'sequence', g,
        'payload', repeat('x', 512)
    )::text,
    md5('perf-update-' || g),
    'actor-' || (g % 50),
    'principal-' || (g % 50),
    'session-' || (g % 50),
    'workspace'
from generate_series(1, 100000) as g
on conflict do nothing;

update crdt_documents document
set stored_update_bytes = updates.update_bytes
from (
    select document_key,
           coalesce(sum(octet_length(update_envelope)), 0)::bigint as update_bytes
    from crdt_updates
    where document_key = 'perf-doc-hot'
    group by document_key
) updates
where document.document_key = updates.document_key;
