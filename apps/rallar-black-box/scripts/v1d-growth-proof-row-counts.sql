-- One growth-proof sample of the run database as one JSON object: row counts per table, status and namespace,
-- the rows already past their expiry that the sweeps have not yet removed, the rows stamped never to expire, live and
-- dead tuples, and the size.
-- The per-process store name of the server AL namespaces is collapsed so a restart does not open a new series.
with
inbox as (
    select
        ri_type_id,
        ri_status,
        expire_ts < (now() at time zone 'UTC') as expired,
        expire_ts >= timestamp '9000-01-01' as never_expires
    from resource_inbox
),
results as (
    select expire_ts < (now() at time zone 'UTC') as expired, expire_ts >= timestamp '9000-01-01' as never_expires
    from resource_inbox_results
),
runtime_state as (
    select
        regexp_replace(store_namespace, '^server-ws-qbox:[^:]+', 'server-ws-qbox:*') as namespace,
        store_key,
        expire_at_ts < now() as expired,
        expire_at_ts >= timestamptz '9000-01-01' as never_expires
    from runtime_state_store
)
select json_build_object(
    'resourceInbox', (
        select json_build_object(
            'total', count(*),
            'expiredPresent', count(*) filter (where expired),
            'neverExpire', count(*) filter (where never_expires),
            'appInbox', count(*) filter (where ri_type_id = 'APP_INBOX'),
            'appInboxFinished', count(*) filter (
                where ri_type_id = 'APP_INBOX' and ri_status in ('COMPLETED', 'FAILED', 'NON_RETRYABLE')
            ),
            'appInboxFinishedNeverExpire', count(*) filter (
                where ri_type_id = 'APP_INBOX' and ri_status in ('COMPLETED', 'FAILED', 'NON_RETRYABLE') and never_expires
            ),
            'appOutbox', count(*) filter (where ri_type_id = 'APP_OUTBOX'),
            'wsOutbox', count(*) filter (where ri_type_id = 'WS_OUTBOX'),
            'alOutbound', count(*) filter (where ri_type_id like 'AL_OUTBOUND%'),
            'alInbound', count(*) filter (where ri_type_id like 'AL_INBOUND%'),
            'neverExpireByType', coalesce((
                select json_object_agg(type_id, rows)
                from (select ri_type_id as type_id, count(*) as rows from inbox where never_expires group by 1) types
            ), '{}'::json),
            'neverExpireByLaneStatus', coalesce((
                select json_object_agg(lane_status, rows)
                from (
                    select split_part(ri_type_id, ':', 1) || ':' || ri_status as lane_status, count(*) as rows
                    from inbox
                    where never_expires
                    group by 1
                ) lanes
            ), '{}'::json),
            'byLaneStatus', coalesce((
                select json_object_agg(lane_status, rows)
                from (
                    select split_part(ri_type_id, ':', 1) || ':' || ri_status as lane_status, count(*) as rows
                    from inbox
                    group by 1
                ) lanes
            ), '{}'::json)
        )
        from inbox
    ),
    'resourceInboxResults', (
        select json_build_object(
            'total', count(*),
            'expiredPresent', count(*) filter (where expired),
            'neverExpire', count(*) filter (where never_expires)
        )
        from results
    ),
    'runtimeState', (
        select json_build_object(
            'total', count(*),
            'expiredPresent', count(*) filter (where expired),
            'byNamespace', coalesce((
                select json_object_agg(namespace, rows)
                from (select namespace, count(*) as rows from runtime_state group by namespace) namespaces
            ), '{}'::json),
            'neverExpireByNamespace', coalesce((
                select json_object_agg(namespace, rows)
                from (
                    select namespace, count(*) as rows from runtime_state where never_expires group by namespace
                ) namespaces
            ), '{}'::json),
            'alm', json_build_object(
                'deliveredMarkers', count(*) filter (where store_key like '%:inbound:admission:delivered:%'),
                'orderingSnapshots', count(*) filter (where store_key like '%:inbound:admission:ordering:%'),
                'dedupRows', count(*) filter (where store_key like '%:inbound:admission:dedup:%')
            )
        )
        from runtime_state
    ),
    'tables', json_build_object(
        'client_state_events', (select count(*) from client_state_events),
        'group_state_events', (select count(*) from group_state_events),
        'rtc_topology_delivery_log', (select count(*) from rtc_topology_delivery_log),
        'rtc_topology_delivery_stream', (select count(*) from rtc_topology_delivery_stream),
        'rtc_topology_replay_cursor', (select count(*) from rtc_topology_replay_cursor),
        'app_data_store', (select count(*) from app_data_store),
        'crdt_documents', (select count(*) from crdt_documents),
        'crdt_updates', (select count(*) from crdt_updates),
        'crdt_snapshots', (select count(*) from crdt_snapshots)
    ),
    'expiredPresent', json_build_object(
        'rtc_topology_delivery_log', (select count(*) from rtc_topology_delivery_log where retain_until < now()),
        'app_data_store', (select count(*) from app_data_store where expire_at_ts < now())
    ),
    'pgStat', (
        select json_object_agg(
            relname,
            json_build_object(
                'live', n_live_tup,
                'dead', n_dead_tup,
                'inserted', n_tup_ins,
                'deleted', n_tup_del,
                'lastAutovacuum', last_autovacuum,
                'bytes', pg_total_relation_size(relid)
            )
        )
        from pg_stat_user_tables
    ),
    'databaseBytes', pg_database_size(current_database())
);
