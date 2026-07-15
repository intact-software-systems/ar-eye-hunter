# Rallar Static Performance Audit

Date: 2026-07-02

Scope: static analysis only. No code was modified for this audit, and no runtime
benchmarks or destructive commands were run.

Primary focus:

- `packages/**`
- `apps/api-v1/src/**`

Static findings are treated as hypotheses unless the code makes the performance
issue obvious.

## Executive Summary

Top 5 risks:

1. State list endpoints can fan out into many DB reads and JSON hydrations,
   especially `/clients` and `/groups`.
2. Legacy state event endpoints load and parse full event histories before
   returning the last page.
3. WebSocket state sync and RTC topology paths repeatedly scan process-wide
   snapshot caches and open connections.
4. QueueBox processing appears intentionally serialized, but may become a
   throughput ceiling under bursts.
5. CRDT, graph, and app-data admin/read paths contain several full-scan and
   full-materialization operations.

## Hot Path Map

Likely high-traffic and/or performance-sensitive execution paths:

- API request path:
  `apps/api-v1/src/main.ts` -> `apps/api-v1/src/create-rallar-server.ts` ->
  `apps/api-v1/src/middleware.ts` -> Hono routes.
- State reads:
  `client-state-routes.ts` / `group-state-routes.ts` -> state services ->
  runtime stores -> Postgres repositories.
- State writes and events:
  routes or app inbox -> QueueBox -> state service -> event repository ->
  state-sync publisher.
- WebSocket path:
  `ws-routes.ts` -> `JsonWebSocketServer` -> `WsQueueBoxServerService` ->
  system and dynamic topics.
- CRDT path:
  CRDT routes/topics -> `RallarCrdtServer` -> `PSqlCrdtLogRepository`.
- Graph and RTC path:
  `graph-topology-routes.ts`, `ws-system-topics.ts` -> graph/topology computation over
  snapshots and RTT data.
- App data path:
  `RallarServerAppDataStore` -> `PSqlAppDataRepository`, with local cache
  hydration.
- Shared black-box and memory tests:
  scenario runners in `packages/shared-test` exercise queue, RTC, WebSocket,
  artifact, and memory-sensitive flows.

## Findings

| Severity | Confidence | Category | Location | Why it is costly | Complexity/memory impact | How to validate | Suggested fix |
| --- | --- | --- | --- | --- | --- | --- | --- |
| High | Strong suspicion | DB fanout | `apps/api-v1/src/routes/client-state-routes.ts:70`, `packages/shared-server/rallar-system/services/client-state-service.ts:149` | `/clients` lists principals, then `Promise.all` reads each snapshot. Each snapshot can read instances and sessions. | O(P * related rows), unbounded concurrent DB work, and large responses. | Count SQL queries and heap during `/api/state/clients` with 10, 100, and 1k principals. | Add pagination, SQL-side joins/projections, bounded concurrency, and summary endpoints. |
| High | Strong suspicion | DB fanout | `apps/api-v1/src/routes/group-state-routes.ts:114`, `packages/shared-server/rallar-system/services/group-state-service.ts:243` | `/groups` lists all groups, filters auth in memory, then hydrates snapshots. | O(G * members/sessions), large heap, and latency spikes. | Query-count middleware and `EXPLAIN` for group/member/session reads under realistic workspace sizes. | Paginate groups, push auth/filtering into repository queries, and add lightweight list projections. |
| High | Proven from code | Event history | `client-state-routes.ts:135`, `group-state-routes.ts:158`, `PSqlStateEventRepository.ts:52`, `state-event-listing.ts:38` | Legacy `/events` routes load all events, parse JSON, copy/filter, then slice to the default 100. | O(E) DB read, JSON parse, and allocation per request. | Compare `/events` vs `/events/page` for a subject with 10k+ events. | Route the legacy endpoint through SQL-limited paging, for example DESC limit then reverse. |
| High | Strong suspicion | Cache and memory | `cache-repositories.ts:15`, `ObservableLatestRepository.ts:25`, `ObservableLatestRepository.ts:248`, `LatestValue.ts:52` | TTL expiry is logical; expired entries remain in Maps until `deleteExpired()` is called. No obvious scheduled cleanup exists for state snapshot caches. | Memory grows with principals, groups, and sessions seen over process lifetime. | Heap snapshots after churn of many principals/groups; inspect cache entry counts vs live values. | Add periodic eviction or a bounded cache policy for server cache repositories. |
| High | Strong suspicion | WebSocket fanout | `state-sync-routing.ts:70`, `state-sync-routing.ts:84`, `ws-system-topics.ts:187`, `JsonWebSocketServer.ts:183` | State sync resolves recipients by scanning cached snapshots, then broadcast scans all connections. | O(snapshot count + open connections) per state message. | Instrument recipients, snapshots scanned, connections scanned, and payload bytes per topic. | Maintain scope/group recipient indexes and update them on snapshot changes. |
| High | Needs runtime measurement | Queue throughput | `RallarMiddleware.ts:154`, `DequeueController.ts:61`, `PSqlQueueBox.ts:63` | WS/app inbox/outbox tasks use `maxConcurrency: 1`; default reserve size is one row. | Serialized throughput, extra round trips, and queue lag under bursts. | Track queue depth, reservation latency, dequeue rate, and p95 lag during traffic tests. | Batch reservations/releases and raise concurrency where ordering guarantees allow. |
| Medium-High | Strong suspicion | DB indexing | `ResourceInboxRepository.ts:270`, `ResourceInboxRepository.ts:328`, `schema.prisma:22` | Queue runnable queries use status/type/range predicates plus `ORDER BY ri_row_id`; index fit is uncertain, especially with `OR` conditions. | Potential scans or sorts on the hot queue table. | `EXPLAIN (ANALYZE, BUFFERS)` for runnable and timeout queries with production-like rows. | Tune partial/composite indexes around runnable/reserved states and next retry time. |
| Medium-High | Strong suspicion | Prefix scans and JSON parse | `RuntimeStateJsonStore.ts:106`, `PSqlRuntimeStateRepository.ts:43`, `PSqlRuntimeStateRepository.ts:54` | Prefix/list operations materialize full `store_value` rows and parse JSON in application code. | O(namespace rows), with large allocations for broad prefixes. | Measure rows read and JSON parse time for principal/group/state namespaces. | Add narrower repositories/queries for known list shapes, paginate, and verify prefix index behavior. |
| Medium-High | Strong suspicion | CRDT/admin | `crdt-admin-routes.ts:58`, `PSqlCrdtLogRepository.ts:376`, `PSqlCrdtLogRepository.ts:427`, `PSqlCrdtLogRepository.ts:813` | Document listing filters in memory; export/integrity paths materialize all records. | O(D) document scans and O(U) update materialization. | Benchmark docs with 1k, 10k, and 100k updates; track heap during export/integrity. | Use SQL-side filtering/paging and streaming export/integrity verification. |
| Medium-High | Needs runtime measurement | CRDT append | `PSqlCrdtLogRepository.ts:608`, `PSqlCrdtLogRepository.ts:1021`, `PSqlCrdtLogRepository.ts:1073` | Appends lock the document row; quota checks sum stored update bytes. This is likely correct but may bottleneck hot docs. | Per-document serialization; quota check may be O(update count). | Measure append latency by concurrent actors per document, quotas on and off. | Store rolling byte totals, batch append where possible, and shorten transaction work while preserving row-lock safety. |
| Medium | Strong suspicion | App data | `RallarServerAppData.ts:198`, `RallarServerAppData.ts:245`, `PSqlAppDataRepository.ts:50` | `hydrate` and `getEntries` load all matching app-data values and refresh local cache. | O(store rows), unbounded response/cache memory. | Test app-data stores at 1k, 10k, and 100k keys and large values. | Add paging/streaming and projection APIs; avoid whole-store hydrate on request paths. |
| Medium | Strong suspicion | RTC topology | `ws-system-topics.ts:445`, `ws-system-topics.ts:565` | RTT measurements scan all group snapshots and active sessions to find affected groups. | O(groups * sessions) per RTT message. | Instrument scan counts and CPU during RTC traffic with many groups. | Maintain a session-to-group index for topology updates. |
| Medium | Needs runtime measurement | Serialization | `WsQueueBoxServerService.ts:410`, `JsonWebSocketServer.ts:173` | Direct multi-recipient sends call `JSON.stringify` per recipient; broadcast encodes once. | O(recipients * payload size) CPU and allocation. | Profile large CRDT/state payload fanout to many recipients. | Add an encoded-send path or pre-serialized message reuse. |
| Medium | Strong suspicion | Rate limiting | `rate-limit-service.ts:11`, `rate-limit-service.ts:25` | Each limiter lookup calls `deleteExpired()`, which can scan all limiter entries. | O(active client IDs) per limited request. | Simulate many distinct client IDs hitting ICE/config/login routes. | Use periodic cleanup or bucketed expiry instead of per-read full eviction. |
| Low-Medium | Needs runtime measurement | Logging | `ws-routes.ts:46`, `WsQueueBoxServerService.ts:610`, `client-state-snapshots-repository.ts:146` | Connection, message, and snapshot logs sit on hot paths. | I/O and formatting overhead under high message volume. | Compare throughput with info/debug logging enabled vs reduced. | Gate noisy logs behind debug level or sampling. |

## False-Positive Risks

- Some full-scan paths may be operator-only or low traffic, especially CRDT
  admin/export routes.
- Queue concurrency of one may be intentional for ordering, idempotency, or
  protocol guarantees.
- Small workspaces may never make `/clients`, `/groups`, or event history
  endpoints material.
- TTL cache entries do not return expired values, so the main issue is retained
  metadata and Map growth, not stale behavior.
- In-memory event stores may only be used in tests or non-production adapters.
- PGlite behavior may differ from deployed Postgres query plans.
- Graph routes may be development or diagnostic surfaces rather than public
  high-traffic endpoints.
- Local pub/sub subscribers appear to be installed once; missing unsubscribe
  behavior matters mainly if middleware/server instances are repeatedly created
  in one long-lived process.

## Measurement Plan

1. Add query-count and timing instrumentation around:
   - `/api/state/clients`
   - `/api/state/groups`
   - `/events`
   - `/events/page`
   - app-data list/hydrate paths
   - CRDT catch-up/admin paths
2. Run Postgres `EXPLAIN (ANALYZE, BUFFERS)` for:
   - `runtime_state_store` namespace and prefix scans
   - `resource_inbox` runnable/reserved queue queries
   - `crdt_updates` append quota, rate-limit, and catch-up queries
   - `app_data_store` prefix/list queries
3. Use existing memory/traffic commands as the first runtime harnesses:
   - `npm run test:rallar:full-stack:memory`
   - `npm run test:shared-black-box:memory:scale`
   - `npm run test:shared-black-box:memory:traffic`
   - `npm run test:shared-black-box:matrix:traffic`
4. Capture heap snapshots before and after high-cardinality churn of:
   - principals
   - groups
   - sessions
   - app-data keys
   - CRDT updates
5. Profile Deno CPU with V8/inspector during:
   - WebSocket state-sync fanout
   - RTC RTT traffic
   - CRDT catch-up
   - CRDT append with quotas enabled
6. Add temporary metrics under `tmp/perf/`:
   - queue depth and queue lag
   - reservation and dequeue latency
   - recipients scanned
   - connections scanned
   - JSON payload bytes
   - cache entry counts
   - SQL rows read

## Do First

1. Measure and fix `/events` loading all history before slicing. This is the
   clearest proven inefficiency.
2. Measure `/clients` and `/groups` query counts and heap use at realistic
   tenant sizes, then add pagination/projections.
3. Instrument WebSocket state-sync and RTC fanout scan counts. If they scale
   with global snapshots/connections, add recipient indexes.

## Notes

- The audit did not attempt to prove production impact. Runtime validation is
  required before accepting optimization work.
- Generated profiling artifacts should go under `tmp/perf/` and should not be
  committed unless explicitly requested.
