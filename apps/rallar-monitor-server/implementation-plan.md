# Rallar Monitor Server Implementation Plan

## Goal

`apps/rallar-monitor-server` should become the Deno backend for Rallar monitoring, black-box run analytics, and production telemetry introspection.

The server should receive stats, events, reports, and topology observations from black-box test infrastructure and production Rallar services. It should expose efficient REST APIs for the `apps/rallar-monitor` UI, and use WebSockets to notify connected monitor clients when fresher data is available.

The first responsibility is observability and analysis, not test orchestration. Control-plane features can be added later only if they fit cleanly around the monitoring model.

## Boundary

Related apps:

```text
apps/black-box-rallar
    -> executes remote-controlled RTC, WebSocket, and HTTP recipes
    -> emits stats, events, diagnostics, reports

production Rallar services
    -> emit runtime stats, topology, health, and production events

apps/rallar-monitor-server
    -> receives and stores telemetry
    -> aggregates and indexes monitoring data
    -> exposes REST query APIs
    -> sends WebSocket freshness notifications

apps/rallar-monitor
    -> fetches bulk data over REST
    -> listens for WebSocket freshness notifications
    -> visualizes runs, production telemetry, topology, time-series, and insights
```

The monitor server should not depend on browser-only code. It can share contracts with `rallar-bb-test` and any future monitor contract package.

## Tech Stack

Use a Deno server, consistent with the existing app servers.

Recommended initial stack:

| Technology | Role |
| --- | --- |
| Deno | Runtime, tasks, tests, and deployment target. |
| Hono | REST routes, middleware, and WebSocket upgrade handling. |
| Postgres | Durable storage for runs, stats, events, rollups, topology, and insights. |
| Prisma or SQL migrations | Schema management; align with the repo's existing database choice when implementation starts. |
| `postgres` Deno/npm client | Direct query path if we avoid Prisma for high-volume ingestion. |
| `rallar-bb-test` | Shared black-box run, recipe, stats, report, and event vocabulary. |
| graphology | Server-side topology construction and graph export where useful. |

Open choice: use Prisma for relational metadata and direct SQL for high-volume telemetry inserts, or keep the first version simpler with one repository layer over Postgres.

## Responsibilities

The server should handle:

- ingesting black-box run metadata, events, stats, diagnostics, and reports
- ingesting production Rallar telemetry
- validating and redacting incoming telemetry
- storing raw events where useful
- producing rollups for efficient dashboards
- serving REST query APIs for monitor UI views
- generating topology snapshots for graph visualisation
- notifying monitor UI clients when newer data exists
- retaining durable insights and annotations
- exposing health and operational endpoints
- enforcing authentication, authorization, payload limits, and retention policies

Future responsibilities may include:

- alert rule evaluation
- anomaly detection
- regression detection against previous runs
- scheduled rollup jobs
- export APIs
- webhook delivery to external tools
- linking monitor insights to issue trackers
- serving precomputed baselines for black-box tests

## Ingestion Model

Use REST ingestion first. It is simpler to make durable, retryable, and batch-friendly than WebSocket ingestion.

Initial ingestion endpoints:

| Endpoint | Purpose |
| --- | --- |
| `POST /api/rallar-monitor/ingest/runs` | Create or update black-box run metadata. |
| `POST /api/rallar-monitor/ingest/runs/:runId/agents` | Register or update agents participating in a run. |
| `POST /api/rallar-monitor/ingest/runs/:runId/commands` | Ingest recipe command results and timings. |
| `POST /api/rallar-monitor/ingest/runs/:runId/events` | Ingest run events, messages, diagnostics, and failures. |
| `POST /api/rallar-monitor/ingest/runs/:runId/stats` | Ingest periodic run stats snapshots. |
| `POST /api/rallar-monitor/ingest/runs/:runId/report` | Ingest final or checkpoint run report fragments. |
| `POST /api/rallar-monitor/ingest/production/events` | Ingest production telemetry events. |
| `POST /api/rallar-monitor/ingest/production/stats` | Ingest production stats snapshots. |
| `POST /api/rallar-monitor/ingest/topology` | Ingest or upsert topology observations. |

All ingestion endpoints should support batches:

```ts
type IngestEnvelope<T> = {
    protocolVersion: 1
    source: 'black-box-runner' | 'black-box-rallar' | 'rallar-api' | 'rallar-ws' | 'production-service'
    environment: string
    producerId: string
    sentAtEpochMs: number
    idempotencyKey?: string
    items: readonly T[]
}
```

Ingestion requirements:

- validate payload shape
- reject unsupported protocol versions
- apply payload size limits
- support idempotency keys
- store server receive time
- redact configured secret fields
- preserve source identity
- return accepted, rejected, and duplicate counts
- emit freshness notifications after successful writes

## Query REST API

The monitor UI should fetch bulk data over REST.

Initial query endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/rallar-monitor/overview` | Summary cards and health for a time window. |
| `GET /api/rallar-monitor/runs` | Paginated run list with filters. |
| `GET /api/rallar-monitor/runs/:runId` | Run detail and report summary. |
| `GET /api/rallar-monitor/runs/:runId/agents` | Agents participating in a run. |
| `GET /api/rallar-monitor/runs/:runId/commands` | Command timeline and outcomes. |
| `GET /api/rallar-monitor/runs/:runId/events` | Cursor-paginated run event stream. |
| `GET /api/rallar-monitor/runs/:runId/stats` | Run stats, raw or downsampled. |
| `GET /api/rallar-monitor/metrics` | Aggregated time-series metrics. |
| `GET /api/rallar-monitor/topology` | Graph topology for a scope and time window. |
| `GET /api/rallar-monitor/production/events` | Cursor-paginated production event stream. |
| `GET /api/rallar-monitor/production/stats` | Production stats snapshots or aggregates. |
| `GET /api/rallar-monitor/insights` | Findings, annotations, suspected bugs, and improvement candidates. |
| `POST /api/rallar-monitor/insights` | Create an insight or annotation. |
| `PUT /api/rallar-monitor/insights/:insightId` | Update insight status, priority, tags, and links. |
| `GET /api/rallar-monitor/health` | Server health and dependency readiness. |

Query requirements:

- time window filters: `from`, `to`
- cursor pagination for event streams
- stable sorting
- dimension filters
- bucket selection for metrics: `bucketMs`
- server-side downsampling
- response truncation metadata
- high-watermark or ETag support where practical
- explicit redaction before returning browser responses

## WebSocket Notifications

Use WebSockets to notify monitor UI clients that fresher data exists. Do not use this socket for bulk metric transfer in the first implementation.

Suggested endpoint:

```text
GET /api/rallar-monitor/ws
```

Suggested notification envelope:

```ts
type MonitorServerNotification = {
    kind:
        | 'run.updated'
        | 'stats.available'
        | 'events.available'
        | 'topology.updated'
        | 'production.updated'
        | 'insight.created'
        | 'alert'
    protocolVersion: 1
    atEpochMs: number
    highWatermark: string
    scope: {
        environment?: string
        runId?: string
        agentId?: string
        region?: string
        app?: string
        metric?: string
    }
    affectedQueries: readonly string[]
    summary?: unknown
}
```

Client behavior:

- receive notification
- invalidate affected REST query keys
- refetch visible views
- show stale/fresh indicators

Server behavior:

- authenticate the WebSocket
- track connected monitor clients
- coalesce repeated notifications
- avoid flooding clients during high-volume ingestion
- send heartbeat/ping messages
- close idle or unauthorized connections

## Data Model

Use separate raw and aggregate storage. Raw data preserves evidence; aggregates keep dashboards fast.

Core tables or collections:

| Entity | Purpose |
| --- | --- |
| `monitor_source` | Registered producers and source identity. |
| `monitor_run` | Black-box run metadata. |
| `monitor_run_agent` | Browser/remote agents participating in a run. |
| `monitor_run_command` | Recipe command lifecycle, timing, result, and error. |
| `monitor_event` | Raw run and production events. |
| `monitor_stats_snapshot` | Periodic stats from agents or services. |
| `monitor_metric_rollup` | Aggregated time-series buckets. |
| `monitor_topology_snapshot` | Graph-shaped state for a time window. |
| `monitor_report_fragment` | Checkpoint and final run reports. |
| `monitor_insight` | Durable findings and annotations. |
| `monitor_ingest_receipt` | Idempotency, duplicates, and ingest audit trail. |

Indexes should prioritize:

- time window queries
- run ID
- environment
- source
- metric name
- actor/session/agent IDs
- room/topic/type IDs
- severity/status for insights

## Metrics And Rollups

The server should calculate dashboard-ready series.

Initial rollups:

- API request count, error count, and latency buckets
- WebSocket connection count and reconnect count
- RTC peer counts and lane health
- `realtime` send/receive counters
- `messages.rtc` delivery/routing counters
- black-box command duration, success, failure, and timeout counts
- run-level pass/fail counts by recipe, environment, and transport

Rollup strategy:

- store raw snapshots/events first
- compute short-window rollups eagerly after ingestion where cheap
- add scheduled rollup jobs later for larger windows
- keep bucket metadata explicit: `bucketStartEpochMs`, `bucketMs`, `aggregation`
- preserve dimensions needed by the monitor UI

## Topology Processing

The server should be able to build topology responses from events and stats.

Topology graph candidates:

- environments
- deployments
- services
- agents
- sessions
- rooms
- overlays
- topics
- peer links
- API routes
- WebSocket topics

Use graphology as an internal representation when it helps normalize nodes and edges before returning JSON to the monitor UI.

Topology response should support:

- selected time window
- run-only, production-only, or combined scope
- failure/degraded highlighting
- collapsed and expanded graph modes
- stable node IDs for UI selection

## Authentication And Authorization

The monitor server has two distinct trust paths.

Ingestion clients:

- black-box infrastructure
- deployed Rallar services
- production telemetry producers

Monitor UI users:

- human users
- CI/report viewers
- operators

Required controls:

- separate tokens or sessions for ingestion and UI access
- environment/source allowlist
- per-source rate limits
- payload size limits
- redaction before storage or before response, depending on data class
- audit trail for ingestion and insight mutations
- CORS allowlist for monitor UI origins

## Server Configuration

Initial environment variables:

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port, default `8091`. |
| `CORS_ORIGINS` | Allowed monitor UI origins. |
| `DATABASE_URL` | Postgres connection string. |
| `MONITOR_INGEST_TOKENS` | Accepted ingestion tokens or token config location. |
| `MONITOR_UI_AUTH_MODE` | Auth mode for local/dev/prod. |
| `MONITOR_RETENTION_DAYS_RAW` | Raw event retention. |
| `MONITOR_RETENTION_DAYS_ROLLUP` | Rollup retention. |
| `MONITOR_MAX_INGEST_BYTES` | Max request body size. |
| `MONITOR_NOTIFICATION_BATCH_MS` | Notification coalescing window. |

## Proposed Iterations

### Iteration 1: Planning Document

Create this implementation plan and agree on server responsibilities, API boundaries, and persistence direction.

Status: documented.

### Iteration 2: Deno Server Scaffold

Create the initial app shell.

Deliverables:

- `deno.json`
- `src/main.ts`
- Hono app setup
- CORS middleware
- `/api/rallar-monitor/health`
- local dev/start/check tasks

### Iteration 3: Shared Contracts

Define monitor DTOs before adding storage.

Deliverables:

- ingestion envelopes
- query DTOs
- notification DTOs
- error response shape
- shared redaction rules
- contract tests

Open decision: keep these contracts inside `apps/rallar-monitor-server` first or move them into a shared package used by `apps/rallar-monitor`.

### Iteration 4: In-memory Repository

Implement the API against an in-memory repository for fast contract validation.

Deliverables:

- run ingestion
- event ingestion
- stats ingestion
- overview query
- run list/detail query
- deterministic tests

### Iteration 5: REST Ingestion API

Add production-shaped ingestion routes with validation and idempotency.

Deliverables:

- batch ingestion routes
- accepted/rejected/duplicate response counts
- payload validation
- idempotency receipt handling
- redaction
- rate-limit hooks

### Iteration 6: REST Query API

Add monitor UI query routes.

Deliverables:

- run list/detail
- events with cursor pagination
- stats by time window
- metrics endpoint
- topology endpoint skeleton
- response truncation metadata

### Iteration 7: WebSocket Notification Hub

Add freshness notifications for monitor UI clients.

Deliverables:

- `/api/rallar-monitor/ws`
- authenticated client registry
- heartbeat
- notification coalescing
- affected query keys
- tests for publish/subscribe behavior

### Iteration 8: Postgres Persistence

Replace or back the in-memory repository with durable storage.

Deliverables:

- schema/migrations
- repository implementation
- indexes for time-window and run queries
- ingest receipts table
- retention metadata
- migration/test workflow

### Iteration 9: Rollups And Downsampling

Make dashboard queries efficient.

Deliverables:

- metric rollup tables
- bucketed aggregation jobs
- server-side downsampling
- raw versus rollup query selection
- rollup correctness tests

### Iteration 10: Production Telemetry Integration

Connect production Rallar services to the ingest API.

Deliverables:

- production event DTOs
- production stats DTOs
- source registration
- example producer integration
- production-safe redaction rules

### Iteration 11: Insights And Annotations API

Add durable knowledge capture.

Deliverables:

- insight CRUD routes
- status, priority, and tag filters
- links to runs, metrics, topology nodes, and production windows
- audit trail

### Iteration 12: Alerts And Derived Findings

Add server-side detection for important changes.

Deliverables:

- alert rule model
- threshold rules
- regression rules against previous runs
- anomaly candidate records
- WebSocket `alert` notifications
- optional webhook delivery later

### Iteration 13: Operations Hardening

Prepare for sustained use.

Deliverables:

- authentication hardening
- source-specific rate limits
- payload size enforcement
- retention cleanup jobs
- backpressure behavior
- structured server logs
- health/readiness checks
- Dockerfile and deployment notes if needed

## Concerns

High-volume telemetry can overwhelm a normal CRUD API. Batch ingestion, payload limits, indexes, and rollups should be designed early.

Raw production telemetry may contain sensitive information. The server should decide which fields are stored raw, redacted, aggregated, or rejected.

The monitor server should keep query APIs stable. The UI should not need to know whether a response came from raw events, rollups, or cached topology snapshots.

WebSocket notifications should be coalesced. A production system can emit many events per second, and the UI only needs to know that a query is stale.

Idempotency matters because black-box agents and production producers will retry failed ingestion requests.

## Open Questions

- Should monitor contracts live in `rallar-bb-test`, a new shared monitor package, or inside the server app initially?
- Should storage use Prisma, direct SQL, or a hybrid repository?
- Should ingestion be accepted directly from production services or routed through existing `apps/api-v1` first?
- What retention policy is acceptable for raw events versus rollups?
- Which fields must be redacted before storage rather than only before query responses?
- Should the server compute insights automatically in the first release, or only store human-authored insights?
- Should topology snapshots be persisted or recomputed from events on demand?
