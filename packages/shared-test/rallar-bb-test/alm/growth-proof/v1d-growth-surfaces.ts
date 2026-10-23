import type { V1dGrowthClassification, V1dGrowthReader, V1dGrowthSurface } from './v1d-growth-surface.ts';

/** The growth survey's rows: every one of them needs a classified surface below. */
export const V1D_GROWTH_SURVEY_SURFACE_IDS: readonly number[] = Array.from(
    { length: 75 },
    (_value, index) => index + 1
);

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const RUNTIME_STATE_SWEEP_MS = MINUTE_MS;
const AL_REPOSITORY_TTL_MS = HOUR_MS;
const AL_VOLATILE_INBOUND_COUNTED_LIFETIME_MS = 30_000;
const AL_ORDERING_TRACKS_PER_STORE = 256;
const AL_DELIVERED_MARKERS_PER_STORE = 256;
const BROWSER_INBOUND_STORES = 2;

const HEAP: V1dGrowthClassification = { growthClass: 'heap' };
/** The committed `appInbox.finishedRetentionMs` default; the run keeps it, so these rows grow for its whole length. */
const FINISHED_APP_INBOX_RETENTION: V1dGrowthClassification = { growthClass: 'ttl-beyond-run', ttlMs: DAY_MS };
const AL_REPOSITORY_ROWS: V1dGrowthClassification = {
    growthClass: 'ttl-within-run',
    ttlMs: AL_REPOSITORY_TTL_MS,
    sweepMs: RUNTIME_STATE_SWEEP_MS
};
const API_HEAP: V1dGrowthReader = {
    source: 'api-heap',
    path: ['heapUsed'],
    absent: 'no-reading',
    neverExpiringPath: null
};
const PAGE_HEAP: V1dGrowthReader = toBrowserReading('browser', 'pageHeap', 'usedJSHeapSize');
const CONTROL_RSS: V1dGrowthReader = {
    source: 'process-rss',
    path: ['control'],
    absent: 'no-reading',
    neverExpiringPath: null
};

function toPostgresCount(...path: readonly string[]): V1dGrowthReader {
    return { source: 'postgres', path, absent: 'zero', neverExpiringPath: null };
}

function toPostgresExpiringCount(path: readonly string[], neverExpiringPath: readonly string[]): V1dGrowthReader {
    return { source: 'postgres', path, absent: 'zero', neverExpiringPath };
}

function toNamespaceCount(namespace: string): V1dGrowthReader {
    return toPostgresExpiringCount(
        ['runtimeState', 'byNamespace', namespace],
        ['runtimeState', 'neverExpireByNamespace', namespace]
    );
}

function toBrowserReading(...path: readonly string[]): V1dGrowthReader {
    return { source: 'browser-stats', path, absent: 'no-reading', neverExpiringPath: null };
}

function toIndexedDbRows(databaseStore: string): V1dGrowthReader {
    return {
        source: 'browser-stats',
        path: ['browser', 'indexedDbRows', databaseStore],
        absent: 'zero',
        neverExpiringPath: null
    };
}

function toRealtimeReading(...path: readonly string[]): V1dGrowthReader {
    return { source: 'admin-realtime', path, absent: 'no-reading', neverExpiringPath: null };
}

function toServerHeapSurface(id: number, name: string, owner: string): V1dGrowthSurface {
    return { id, name, owner, classification: HEAP, readers: [API_HEAP] };
}

function toPageHeapSurface(id: number, name: string, owner: string): V1dGrowthSurface {
    return { id, name, owner, classification: HEAP, readers: [PAGE_HEAP] };
}

function toDurable(entity: string, entityNamespace: string, rowsPerEntity: number): V1dGrowthClassification {
    return {
        growthClass: 'durable',
        entity,
        entityCount: { source: 'samples', reader: toNamespaceCount(entityNamespace) },
        rowsPerEntity
    };
}

/** One row per group, per principal or per membership, each counted from the samples. */
const PER_GROUP = toDurable('groups', 'group-state:groups', 1);
const PER_PRINCIPAL = toDurable('principals', 'client-state:principals', 1);
const PER_MEMBERSHIP = toDurable('memberships', 'group-state:members', 1);
/** A churn principal joins the medium-scale profile's five groups, and each group's owner adds one membership. */
const MEMBERSHIPS_PER_PRINCIPAL = toDurable('principals', 'client-state:principals', 6);
/** The clients the medium-scale churn recipe registers; `v1d-growth-surfaces.test.ts` reads them from the recipe. */
const MEDIUM_SCALE_PRINCIPALS_PER_CHURN_ITERATION = 100;
/**
 * An account is registered before its principal connects, so the auth users run ahead of the principals while an
 * iteration registers; they grow with the accounts the run registered, a client id never without its username.
 */
const PER_REGISTERED_ACCOUNT: V1dGrowthClassification = {
    growthClass: 'durable',
    entity: 'registered accounts',
    entityCount: {
        source: 'registrations',
        principalsPerChurnIteration: MEDIUM_SCALE_PRINCIPALS_PER_CHURN_ITERATION,
        ceiling: toNamespaceCount('auth-users:by-username')
    },
    rowsPerEntity: 1
};

/**
 * Every growth surface with its class, bound and readers: the survey's 75 rows, then the runtime-state namespaces
 * the sampler found that the survey did not list.
 */
export const V1D_GROWTH_SURFACES: readonly V1dGrowthSurface[] = [
    {
        id: 1,
        name: 'resource_inbox rows that carry an expiry (retry horizon, WS_INBOX, topology publication)',
        owner: 'packages/shared-server/queuebox/postgres/resource-inbox-maintenance.ts',
        classification: { growthClass: 'ttl-beyond-run', ttlMs: DAY_MS },
        readers: [toPostgresExpiringCount(['resourceInbox', 'total'], ['resourceInbox', 'neverExpireSettled'])]
    },
    {
        id: 2,
        name: 'resource_inbox finished APP_INBOX facts and their derived outbox rows',
        owner: 'packages/shared-server/rallar-system/app-inbox/client/create-app-inbox-client-runtime.ts',
        classification: FINISHED_APP_INBOX_RETENTION,
        readers: [
            toPostgresExpiringCount(['resourceInbox', 'appInboxFinished'], [
                'resourceInbox',
                'appInboxFinishedNeverExpire'
            ])
        ]
    },
    {
        id: 3,
        name: 'resource_inbox_results',
        owner: 'packages/shared-server/queuebox/postgres/resource-inbox-result-replacement.ts',
        classification: FINISHED_APP_INBOX_RETENTION,
        readers: [toPostgresExpiringCount(['resourceInboxResults', 'total'], ['resourceInboxResults', 'neverExpire'])]
    },
    {
        id: 4,
        name: 'runtime_state_store client-state:sessions',
        owner: 'packages/shared-server/rallar-system/presence/session-expiry.ts',
        classification: { growthClass: 'ttl-beyond-run', ttlMs: 7 * DAY_MS },
        readers: [toNamespaceCount('client-state:sessions')]
    },
    {
        id: 5,
        name: 'runtime_state_store group-state:sessions (presence)',
        owner: 'packages/shared-server/rallar-system/group-state/presence/reconcile-expired-group-presence.ts',
        classification: { growthClass: 'ttl-beyond-run', ttlMs: 2 * DAY_MS },
        readers: [toNamespaceCount('group-state:sessions')]
    },
    {
        id: 6,
        name: 'runtime_state_store group-state:groups',
        owner: 'packages/shared-server/rallar-system/group-state/persistence/group-aggregate-write-descriptors.ts',
        classification: PER_GROUP,
        readers: [toNamespaceCount('group-state:groups')]
    },
    {
        id: 7,
        name: 'runtime_state_store rows keyed per group that never expire',
        owner: 'packages/shared-server/rallar-system/group-state, topology',
        classification: PER_GROUP,
        readers: [
            'group-state:presence-summaries',
            'group-state:connect-trigger-latches',
            'rtc-topology:snapshots',
            'rtc-topology:accepted-snapshots',
            'rtc-topology:input-fingerprints'
        ].map(toNamespaceCount)
    },
    {
        id: 7,
        name: 'runtime_state_store rows keyed per principal that never expire',
        owner: 'packages/shared-server/rallar-system/client-state',
        classification: PER_PRINCIPAL,
        readers: ['client-state:principals', 'client-state:instances'].map(toNamespaceCount)
    },
    {
        id: 7,
        name: 'runtime_state_store auth users, keyed per registered account, that never expire',
        owner: 'packages/shared-server/rallar-system/auth',
        classification: PER_REGISTERED_ACCOUNT,
        readers: ['auth-users:by-username', 'auth-users:by-client-id'].map(toNamespaceCount)
    },
    {
        id: 7,
        name: 'runtime_state_store group-state:members',
        owner: 'packages/shared-server/rallar-system/group-state/membership/group-state-member-put-descriptor.ts',
        classification: MEMBERSHIPS_PER_PRINCIPAL,
        readers: [toNamespaceCount('group-state:members')]
    },
    {
        id: 7,
        name: 'runtime_state_store group-state:presence-admissions',
        owner: 'packages/shared-server/rallar-system/group-state/presence/group-presence-write-descriptors.ts',
        classification: PER_MEMBERSHIP,
        readers: [toNamespaceCount('group-state:presence-admissions')]
    },
    {
        id: 8,
        name: 'runtime_state_store group-state:idempotent and client-state:idempotent',
        owner:
            'packages/shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation-persistence.ts',
        classification: FINISHED_APP_INBOX_RETENTION,
        readers: [toNamespaceCount('group-state:idempotent'), toNamespaceCount('client-state:idempotent')]
    },
    {
        id: 9,
        name: 'runtime_state_store auth sessions and tickets',
        owner: 'packages/shared-server/rallar-system/auth/persistence/auth-storage-keys.ts',
        classification: { growthClass: 'ttl-beyond-run', ttlMs: 30 * DAY_MS },
        readers: [
            'auth-sessions:by-token',
            'auth-sessions:by-session',
            'auth-sessions:ws-tickets',
            'auth-sessions:agent-session-tickets'
        ].map(toNamespaceCount)
    },
    {
        id: 10,
        name: 'server AL inbound admission rows',
        owner: 'packages/shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts',
        classification: AL_REPOSITORY_ROWS,
        readers: [toNamespaceCount('server-ws-qbox:*:inbound:admission')]
    },
    {
        id: 10,
        name: 'server AL outbound admission rows (each message\'s rows last until its WS_OUTBOX deadline, a day)',
        owner: 'packages/shared/alm/outbound/admission/al-outbound-admission-mutations.ts',
        classification: { growthClass: 'ttl-beyond-run', ttlMs: DAY_MS },
        readers: [toNamespaceCount('server-ws-qbox:*:outbound:admission')]
    },
    {
        id: 11,
        name:
            'server delivered markers (uncapped by ruling; an hour after the track last moved; barely exercised here)',
        owner: 'packages/shared/alm/inbound/admission/al-inbound-delivery-mutations.ts',
        classification: AL_REPOSITORY_ROWS,
        readers: [toPostgresCount('runtimeState', 'alm', 'deliveredMarkers')]
    },
    {
        id: 12,
        name: 'runtime_state_store rtc-rtt:receipts',
        owner: 'packages/shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-receipt-cleanup.ts',
        classification: { growthClass: 'ttl-beyond-run', ttlMs: DAY_MS },
        readers: [toNamespaceCount('rtc-rtt:receipts')]
    },
    {
        id: 13,
        name: 'client_state_events',
        owner: 'packages/shared-server/rallar-system/client-state/mutation/write-client-mutation.ts',
        classification: { growthClass: 'declared-append-only', history: 'one event per client state mutation' },
        readers: [toPostgresCount('tables', 'client_state_events')]
    },
    {
        id: 14,
        name: 'group_state_events',
        owner: 'packages/shared-server/rallar-system/group-state/mutation/write/write-group-mutation.ts',
        classification: { growthClass: 'declared-append-only', history: 'one event per group state mutation' },
        readers: [toPostgresCount('tables', 'group_state_events')]
    },
    {
        id: 15,
        name: 'rtc_topology_delivery_log',
        owner:
            'packages/shared-server/rallar-system/topology/replay/postgres/p-sql-rtc-topology-delivery-repository.ts',
        classification: { growthClass: 'ttl-beyond-run', ttlMs: DAY_MS },
        readers: [toPostgresCount('tables', 'rtc_topology_delivery_log')]
    },
    {
        id: 16,
        name: 'rtc_topology_delivery_stream',
        owner: 'packages/shared-server/rallar-system/topology/replay/postgres/p-sql-rtc-topology-replay-maintenance.ts',
        classification: { growthClass: 'ttl-within-run', ttlMs: 30_000, sweepMs: MINUTE_MS },
        readers: [toPostgresCount('tables', 'rtc_topology_delivery_stream')]
    },
    {
        id: 17,
        name: 'rtc_topology_replay_cursor',
        owner: 'packages/shared-server/rallar-system/topology/replay/postgres/p-sql-rtc-topology-replay-repository.ts',
        classification: { growthClass: 'ttl-beyond-run', ttlMs: DAY_MS },
        readers: [toPostgresCount('tables', 'rtc_topology_replay_cursor')]
    },
    {
        id: 18,
        name: 'app_data_store',
        owner: 'packages/shared-server/app-data/postgres/p-sql-app-data-repository.ts',
        classification: {
            growthClass: 'unbounded',
            missingBound: 'rows expire only when read; no sweep (api-v1 writes none)'
        },
        readers: [toPostgresCount('tables', 'app_data_store')]
    },
    {
        id: 19,
        name: 'crdt_documents, crdt_updates, crdt_snapshots',
        owner: 'packages/shared-server/rallar-system/crdt/persistence/psql-crdt-mutation-repository.ts',
        classification: { growthClass: 'declared-append-only', history: 'CRDT append history' },
        readers: [
            toPostgresCount('tables', 'crdt_documents'),
            toPostgresCount('tables', 'crdt_updates'),
            toPostgresCount('tables', 'crdt_snapshots')
        ]
    },
    {
        id: 20,
        name: 'group-audience cache (GroupStateCurrentSnapshotCache)',
        owner: 'packages/shared-server/rallar-system/group-state/snapshot/group-state-current-snapshot-cache.ts',
        classification: { growthClass: 'count-capped', cap: 512 },
        readers: [toRealtimeReading('caches', 'groupAudienceSnapshots')]
    },
    {
        id: 21,
        name:
            'VersionProbedReadThroughCache entries (the process has one, the group-audience cache, so row 20 reads it)',
        owner: 'packages/shared/cache/store-backed/version-probed-read-through-cache.ts',
        classification: { growthClass: 'count-capped', cap: 512 },
        readers: [toRealtimeReading('caches', 'groupAudienceSnapshots')]
    },
    toServerHeapSurface(
        22,
        'group and client snapshot read-through caches (ObservableLoanedRepository)',
        'packages/shared-server/rallar-system/group-state/snapshot/group-state-snapshot-read-through-cache.ts'
    ),
    toServerHeapSurface(
        23,
        'middleware repositories (snapshots, RTT pairs, graphs, Vivaldi nodes)',
        'packages/shared-server/rallar-system/middleware/cache-repositories.ts'
    ),
    toServerHeapSurface(
        24,
        'groupSessionIndexes and observedGroupSnapshotKeys',
        'packages/shared/repository/group-state-snapshots-repository.ts'
    ),
    toServerHeapSurface(25, 'rate-limit windows', 'packages/shared-server/http/rate-limit-service.ts'),
    toServerHeapSurface(26, 'PSqlFragment interning maps', 'packages/shared-server/postgres/p-sql-fragment.ts'),
    toServerHeapSurface(27, 'statement census totals by shape', 'apps/api-v1/src/db/postgres-statement-census.ts'),
    toServerHeapSurface(
        28,
        'AppInbox completion subscriptions and safety tick',
        'packages/shared/queuebox/resource-inbox/resource-inbox-completion-notifications.ts'
    ),
    toServerHeapSurface(29, 'InboxOutboxEngine timer and lane maps', 'packages/shared/services/inbox-outbox-engine.ts'),
    toServerHeapSurface(
        30,
        'DequeueLaneFlight unreleased reservations',
        'packages/shared/queuebox/dequeue/dequeue-lane-flight.ts'
    ),
    toServerHeapSurface(
        31,
        'maps deleted when work completes (handlers, single flights, write buffers, commit queues)',
        'packages/shared/alm/outbound/al-outbound-dispatch-admission.ts'
    ),
    toServerHeapSurface(
        32,
        'AUTHORISED_CONNECTIONS',
        'apps/api-v1/src/runtime/rtc-topology/authorised-ws-connection-registry.ts'
    ),
    toServerHeapSurface(33, 'JsonWebSocketServer connections', 'packages/shared/websocket/json-web-socket-server.ts'),
    toServerHeapSurface(34, 'ExpectedConnectionHolds', 'packages/shared/websocket/expected-connection-holds.ts'),
    toServerHeapSurface(
        35,
        'RallarWsLifecycleService pending close writes',
        'packages/shared-server/rallar-system/websocket/ws-lifecycle-service.ts'
    ),
    toServerHeapSurface(
        36,
        'RtcTopologyReconnectHydrator pending and retries',
        'packages/shared-server/rallar-system/topology/replay/hydration/rtc-topology-reconnect-hydrator.ts'
    ),
    toServerHeapSurface(
        37,
        'WS server receipt aggregates',
        'packages/shared/services/ws-queue-box-server/ws-queue-box-server-receipt-aggregation.ts'
    ),
    toServerHeapSurface(
        38,
        'WS server ACK relay budgets',
        'packages/shared/services/ws-queue-box-server/ws-queue-box-server-ack-relay.ts'
    ),
    toServerHeapSurface(
        39,
        'RTT refinement observations and decisions',
        'packages/shared-server/rallar-system/rtc-rtt/topic/rtc-rtt-refinement-service.ts'
    ),
    toServerHeapSurface(
        40,
        'RtcRttRefinementGate per-group maps',
        'packages/shared-server/rallar-system/rtc-rtt/topic/rtc-rtt-refinement-gate.ts'
    ),
    toServerHeapSurface(
        41,
        'DeferredFormationCriterionPetitioner per-group map',
        'packages/shared-server/rallar-system/topology/replay/work/formation-criterion-observer.ts'
    ),
    toServerHeapSurface(
        42,
        'RtcTopologySnapshotRegistry',
        'packages/shared-server/rallar-system/topology/runtime/rtc-topology-snapshot-registry.ts'
    ),
    {
        id: 43,
        name: 'ALM receipt diagnostics',
        owner: 'packages/shared-server/rallar-system/observability/alm-receipt-diagnostics.ts',
        classification: { growthClass: 'count-capped', cap: 256 },
        readers: [toRealtimeReading('almReceipts', 'diagnostics', 'messages', 'length')]
    },
    toServerHeapSurface(
        44,
        'formation metrics topic maps',
        'packages/shared-server/rallar-system/observability/formation-metrics.ts'
    ),
    toServerHeapSurface(
        45,
        'password derivation admission queue',
        'packages/shared-server/rallar-system/auth (BoundedConcurrencyAdmission)'
    ),
    {
        id: 46,
        name: 'per-session volatile ledger',
        owner: 'packages/shared/alm/volatile-budget/al-volatile-session-budget.ts',
        classification: { growthClass: 'count-capped', cap: 1_000 },
        readers: [toBrowserReading('rallar', 'alm', 'usage', 'admissions')]
    },
    {
        id: 47,
        name: 'volatile ledger inbound pool',
        owner: 'packages/shared/alm/volatile-budget/al-volatile-session-budget.ts',
        classification: { growthClass: 'ttl-within-run', ttlMs: AL_VOLATILE_INBOUND_COUNTED_LIFETIME_MS, sweepMs: 0 },
        readers: [toBrowserReading('rallar', 'alm', 'inbound', 'admissions')]
    },
    {
        id: 48,
        name: 'browser receiver ordering snapshots',
        owner: 'packages/shared/alm/inbound/admission/evict-al-inbound-ordering-tracks-past-cap.ts',
        classification: { growthClass: 'count-capped', cap: AL_ORDERING_TRACKS_PER_STORE * BROWSER_INBOUND_STORES },
        readers: [toBrowserReading('rallar', 'alm', 'orderingTracks')]
    },
    {
        id: 49,
        name:
            'browser delivered markers (one cap of 256 per inbound store, every sender\'s together; 2 stores per page)',
        owner: 'packages/shared/alm/inbound/admission/evict-al-inbound-delivered-markers-past-cap.ts',
        classification: {
            growthClass: 'count-capped',
            cap: AL_DELIVERED_MARKERS_PER_STORE * BROWSER_INBOUND_STORES
        },
        readers: [toBrowserReading('rallar', 'alm', 'deliveredMarkers')]
    },
    {
        id: 50,
        name: 'inbound dedup rows',
        owner: 'packages/shared/alm/inbound/admission/al-inbound-delivery-mutations.ts',
        classification: HEAP,
        readers: [PAGE_HEAP, API_HEAP]
    },
    {
        id: 51,
        name: 'inbound buffered releases, owner rows, envelopes, control rows',
        owner: 'packages/shared/alm/inbound/al-inbound-admission-store.ts',
        classification: HEAP,
        readers: [PAGE_HEAP, API_HEAP]
    },
    {
        id: 52,
        name: 'outbound memory-pair rows',
        owner: 'packages/shared/alm/outbound/admission/al-outbound-admission-store.ts',
        classification: HEAP,
        readers: [PAGE_HEAP, API_HEAP]
    },
    {
        id: 53,
        name: 'memory-pair maps (admission backend, in-memory queue box)',
        owner: 'packages/shared/alm/al-admission-backend.ts',
        classification: HEAP,
        readers: [PAGE_HEAP, API_HEAP]
    },
    toPageHeapSurface(
        54,
        'ALOutboundSendControls cancelled and handed-over ids',
        'packages/shared/alm/outbound/lane/al-outbound-send-controls.ts'
    ),
    toPageHeapSurface(
        55,
        'repair exhaustion set and canonical hand-off map',
        'packages/shared/alm/outbound/al-outbound-repair-retransmission.ts'
    ),
    toPageHeapSurface(
        56,
        'browser resync-recovery invoked tracks',
        'packages/shared-web/browser/messages/browser-resync-recovery.ts'
    ),
    {
        id: 57,
        name: 'channel backpressure counters (dropped)',
        owner: 'packages/shared/multicast/rtc-outbound-submission.ts',
        classification: { growthClass: 'count-capped', cap: 0 },
        readers: [toBrowserReading('rallar', 'congestion', 'dropped')]
    },
    toPageHeapSurface(
        58,
        'checkpoint memory lane and dirty set',
        'packages/shared/alm/checkpoint/al-checkpoint-dirty-set.ts'
    ),
    toPageHeapSurface(
        59,
        'WebRtcOverlayMulticastManager per-overlay multicasters',
        'packages/shared/multicast/web-rtc-overlay-multicast-manager.ts'
    ),
    toPageHeapSurface(60, 'session store-factory registry', 'packages/shared/alm/ALRuntimeStoreRegistry.ts'),
    {
        id: 61,
        name: 'browser AL admission IndexedDB rows',
        owner: 'packages/shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts',
        classification: AL_REPOSITORY_ROWS,
        readers: [toIndexedDbRows('rallar-al-runtime/entries')]
    },
    {
        id: 62,
        name: 'browser AL work queue (alm-work)',
        owner: 'packages/shared/queuebox/indexed-db-queue-box.ts',
        classification: AL_REPOSITORY_ROWS,
        readers: [toIndexedDbRows('rallar-al-runtime/alm-work')]
    },
    {
        id: 63,
        name: 'browser AL checkpoint rows (they share the admission rows\' store, so its hour bounds them)',
        owner: 'packages/shared-web/browser/al-runtime/browser-al-checkpoint-stores.ts',
        classification: AL_REPOSITORY_ROWS,
        readers: [toIndexedDbRows('rallar-al-runtime/entries')]
    },
    {
        id: 64,
        name: 'Rallar Data IndexedDB and its memory mirror',
        owner: 'packages/shared-web/browser/data/browser-rallar-data-repository.ts',
        classification: {
            growthClass: 'unbounded',
            missingBound: 'no expiry by default and no key cap; the app owns its keys'
        },
        readers: [toIndexedDbRows('rallar-custom-data')]
    },
    {
        id: 65,
        name: 'CRDT local IndexedDB stores',
        owner: 'packages/shared-web/browser/crdt/browser-crdt-local-store.ts',
        classification: {
            growthClass: 'unbounded',
            missingBound: 'no expiry and no cap on the seen, pending and snapshot rows'
        },
        readers: [toIndexedDbRows('rallar-crdt')]
    },
    toPageHeapSurface(66, 'CRDT engine maps', 'packages/shared/crdt/crdt-operations.ts'),
    toPageHeapSurface(
        67,
        'browser delivery registry and fallback watches',
        'packages/shared-web/browser/messages/browser-rallar-delivery-registry.ts'
    ),
    toPageHeapSurface(
        68,
        'people and room event dedup sets',
        'packages/shared-web/browser/people/browser-rallar-people-events.ts'
    ),
    toPageHeapSurface(
        69,
        'browser snapshot caches, overlays and deferred topologies',
        'packages/shared-web/browser/state-cache/initialise-browser-cache-repositories.ts'
    ),
    toPageHeapSurface(
        70,
        'small fixed caps (snapshot transfers, held RTC signals, data-channel queue)',
        'packages/shared/services/state-snapshot-assembly.ts'
    ),
    toPageHeapSurface(71, 'peer maps', 'packages/shared/services/web-rtc-connection-service.ts'),
    toPageHeapSurface(
        72,
        'endedSessionKeys and WS ticket local limiters',
        'packages/shared-web/browser/composition/browser-facade-runtime-state.ts'
    ),
    {
        id: 73,
        name: 'control server per-run evidence',
        owner: 'apps/rallar-black-box-control-server/src/control-runtime-retention.ts',
        classification: HEAP,
        readers: [CONTROL_RSS]
    },
    {
        id: 74,
        name: 'control server runs, distributed runs, fleet reports',
        owner: 'apps/rallar-black-box-control-server/src/control-snapshot-persistence.ts',
        classification: HEAP,
        readers: [CONTROL_RSS]
    },
    {
        id: 75,
        name: 'control server completed command ids, run tokens, failed capture runs',
        owner: 'apps/rallar-black-box-control-server/src/control-service.ts',
        classification: HEAP,
        readers: [CONTROL_RSS]
    },
    {
        id: 76,
        name: 'runtime_state_store ws-outbox-provenance (not in the survey)',
        owner: 'packages/shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts',
        classification: { growthClass: 'ttl-beyond-run', ttlMs: DAY_MS },
        readers: [toNamespaceCount('ws-outbox-provenance')]
    },
    {
        id: 77,
        name: 'runtime_state_store ws-session-close-high-water (not in the survey)',
        owner: 'packages/shared-server/rallar-system/websocket/ws-session-generation-computation.ts',
        classification: { growthClass: 'ttl-beyond-run', ttlMs: 30 * DAY_MS },
        readers: [toNamespaceCount('ws-session-close-high-water')]
    },
    {
        id: 78,
        name: 'runtime_state_store group topology configuration (not in the survey)',
        owner:
            'packages/shared-server/rallar-system/topology/config/persistence/group-topology-config-runtime-namespaces.ts',
        classification: PER_GROUP,
        readers: [
            'group-topology:config',
            'group-topology:config-generation',
            'group-topology:config-invariant-generation'
        ].map(toNamespaceCount)
    },
    {
        id: 78,
        name:
            'runtime_state_store group-topology:config-mutation, the topology idempotency records (not in the survey)',
        owner:
            'packages/shared-server/rallar-system/topology/config/mutation/compute-topology-config-runtime-writes.ts',
        classification: FINISHED_APP_INBOX_RETENTION,
        readers: [toNamespaceCount('group-topology:config-mutation')]
    },
    {
        id: 79,
        name: 'runtime_state_store group-state:lifecycle-policies (not in the survey)',
        owner: 'packages/shared-server/rallar-system/group-state/persistence/group-lifecycle-policy-repository.ts',
        classification: PER_GROUP,
        readers: [toNamespaceCount('group-state:lifecycle-policies')]
    },
    {
        id: 80,
        name: 'runtime_state_store rtc-topology publications (not in the survey)',
        owner: 'packages/shared-server/rallar-system/topology/replay',
        classification: { growthClass: 'ttl-beyond-run', ttlMs: DAY_MS },
        readers: [
            toNamespaceCount('rtc-topology:publications'),
            toNamespaceCount('rtc-topology:publication-work-index')
        ]
    },
    {
        id: 81,
        name: 'runtime_state_store RTT latest pairs and endpoint admissions (not in the survey)',
        owner: 'packages/shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-repository.ts',
        classification: { growthClass: 'ttl-within-run', ttlMs: MINUTE_MS, sweepMs: RUNTIME_STATE_SWEEP_MS },
        readers: [toNamespaceCount('rtc-rtt:latest'), toNamespaceCount('rtc-rtt:endpoint-admission')]
    }
];
