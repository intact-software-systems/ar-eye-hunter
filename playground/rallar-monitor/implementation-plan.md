# Rallar Monitor Implementation Plan

## Goal

`apps/rallar-monitor` should become the operational and analytical UI for Rallar usage.

The app should combine statistics from black-box test runs with live production telemetry so we can inspect distributed Rallar behavior, compare test and production signals, identify improvement points, find bugs, and discover new product or application opportunities.

The monitor is read-heavy. It should fetch bulk data efficiently from a server over REST. WebSocket notifications should tell the UI when newer data is available, after which the UI can refetch the affected REST resources.

## Boundary

`apps/black-box-rallar` executes remote-controlled RTC, WebSocket, and HTTP recipes.

`apps/rallar-monitor-server` is the planned Deno backend for ingesting, storing, aggregating, and serving monitor data.

`apps/rallar-monitor` observes and analyzes:

```text
black-box test agents
production Rallar services
    -> stats, events, reports, topology, health
        -> apps/rallar-monitor-server
            -> REST queries for bulk data
            -> WebSocket notifications for freshness
                -> apps/rallar-monitor
```

The monitor should not be the first place where test recipes are executed. It may later link to run controls or trigger orchestration, but its first responsibility is introspection, comparison, and diagnosis.

## Tech Stack

Use React plus Vite, consistent with the other app packages.

Core dependencies and roles:

| Technology | Role |
| --- | --- |
| React | App shell, views, controls, and composition. |
| Rallar | Auth/session context, live production integration, and possible notification transport where appropriate. |
| `rallar-bb-test` | Shared vocabulary for black-box run stats, reports, events, and recipe outcomes. |
| TanStack Query | REST data fetching, caching, query invalidation, pagination, and background refetch. |
| graphology | Topology data model for agents, sessions, rooms, peers, routes, and services. |
| Sigma.js | Interactive graph rendering for graphology-backed topology views. |
| Apache ECharts | Recommended first time-series and dashboard chart library. |
| uPlot | Candidate for very dense or high-frequency time-series panels if ECharts becomes too heavy. |
| Recharts | Candidate for simple React-native charts, not the default for large telemetry views. |

Initial recommendation: start with Apache ECharts for time-series dashboards because it supports time axes, data zoom, multiple axes, and mixed chart types. Revisit uPlot when we have evidence that dense, high-frequency panels need a smaller and faster canvas-first renderer.

## Data Sources

The monitor should support two broad input families.

Black-box test data:

- run metadata
- recipes and selected configuration
- command results
- RTC, WebSocket, and HTTP events
- periodic stats snapshots
- final reports
- failures, retries, and timeouts
- seeds and selected order for randomized runs

Production Rallar data:

- API request volume, latency, and failures
- WebSocket connection counts and reconnects
- Rallar auth/connect status
- active sessions and actors
- rooms, memberships, overlays, and routes
- RTC peer link health
- `rallar.realtime` send/receive counters
- `rallar.messages.rtc` routing and delivery counters
- server-side queue or topic lag where available
- regional or deployment-specific dimensions

## Data Model

Use explicit, queryable entities rather than only raw logs.

Primary entities:

| Entity | Purpose |
| --- | --- |
| `Run` | One black-box test execution. |
| `RunAgent` | One browser or remote agent participating in a run. |
| `RunCommand` | One recipe command and its result. |
| `RunEvent` | Event, diagnostic, or message emitted during a run. |
| `StatsSnapshot` | Periodic point-in-time stats from an agent or service. |
| `MetricSeries` | Aggregated time-series data for dashboards. |
| `TopologySnapshot` | Graph-shaped room/session/peer/service state at a time window. |
| `ProductionSignal` | Production telemetry event or aggregate. |
| `Insight` | Human or system generated finding, bug candidate, or improvement point. |

Important dimensions:

- environment
- region
- deployment
- app name
- Rallar version
- build SHA
- transport family: RTC, WebSocket, HTTP
- RTC transport: `realtime` or `messages.rtc`
- room ID
- overlay ID
- topic ID
- type ID
- actor
- session ID
- run ID
- agent ID

## REST API Shape

REST should be the primary path for data retrieval.

Suggested endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/rallar-monitor/overview` | Summary cards and top-level health for a time window. |
| `GET /api/rallar-monitor/runs` | Paginated black-box run list. |
| `GET /api/rallar-monitor/runs/:runId` | Run detail, status, recipe summary, and report summary. |
| `GET /api/rallar-monitor/runs/:runId/events` | Cursor-paginated run events. |
| `GET /api/rallar-monitor/runs/:runId/stats` | Downsampled or raw run stats for selected agents. |
| `GET /api/rallar-monitor/metrics` | Time-series metrics by metric name, dimensions, window, and bucket size. |
| `GET /api/rallar-monitor/topology` | Graph topology for a selected time window and scope. |
| `GET /api/rallar-monitor/production/events` | Cursor-paginated production events. |
| `GET /api/rallar-monitor/insights` | Findings, annotations, suspected bugs, and improvement candidates. |

REST query requirements:

- time window parameters: `from`, `to`
- bucket size: `bucketMs`
- pagination or cursor for long event streams
- dimension filters
- stable sorting
- ETag or high-watermark support where practical
- server-side downsampling for large time-series queries
- response size limits with clear truncation metadata

## WebSocket Freshness Notifications

Use WebSocket for freshness and urgent notifications, not for bulk data transfer.

Suggested notification envelope:

```ts
type MonitorNotification = {
    kind: 'stats.available' | 'run.updated' | 'topology.updated' | 'insight.created' | 'alert'
    protocolVersion: 1
    atEpochMs: number
    scope: {
        environment?: string
        runId?: string
        region?: string
        app?: string
    }
    highWatermark?: string
    affectedQueries?: readonly string[]
    summary?: unknown
}
```

The client should use these notifications to invalidate or refetch the relevant REST queries. This keeps the app efficient and avoids pushing large result sets over WebSocket.

## UI Views

Initial views:

| View | Purpose |
| --- | --- |
| Overview | Current health, recent failures, active runs, production load, and important trends. |
| Run Explorer | Browse black-box runs, recipes, command outcomes, stats, and final reports. |
| Run Detail | Timeline, command log, agent stats, RTC/WS/HTTP breakdown, and failure diagnostics. |
| Production Live | Current production sessions, rooms, WebSocket connections, and API health. |
| Topology | Graphology/Sigma view of agents, sessions, rooms, peers, routes, and services. |
| Time Series | Metrics explorer for latency, volume, failures, reconnects, peer counts, and delivery rates. |
| Insights | Saved findings, annotations, suspected bugs, improvement points, and application ideas. |

The first screen should be the operational overview, not a landing page.

## Topology Visualisation

Use graphology as the in-memory graph model and Sigma.js as the renderer.

Candidate node types:

- environment
- deployment
- service
- agent
- session
- room
- overlay
- topic
- peer link

Candidate edge types:

- connected to
- joined room
- publishes topic
- subscribes topic
- RTC peer link
- routed message
- failed delivery

Topology should support filtering by time window, run ID, environment, region, transport, and failure state.

## Time-series Visualisation

Start with Apache ECharts for time-series and dashboard charts.

Useful initial charts:

- API latency percentiles by route
- API error rate by route
- WebSocket active connections over time
- reconnect rate over time
- RTC peer count by room
- `realtime` send/receive counters
- `messages.rtc` delivery and routing counters
- black-box command latency by command type
- run failure rate by recipe or transport

Data should be downsampled on the server for large windows. The UI should request raw data only for narrow windows or detailed drill-downs.

## Insight Model

The monitor should make findings durable.

Insight examples:

- repeated timeout pattern in a recipe
- production-only reconnect spike
- failed RTC link correlated with region or browser version
- test coverage gap found from production topology
- high-latency API route that slows connect/setup
- potential new app feature suggested by observed usage

Insights should support:

- title and description
- severity or priority
- related run IDs
- related production time window
- related metrics or topology nodes
- status: open, investigating, fixed, archived
- tags
- links to issue trackers later

## Proposed Iterations

### Iteration 1: Planning Document

Create this implementation plan and agree on app boundaries, data sources, and first visualisation choices.

Status: documented.

### Iteration 2: React App Scaffold

Create `apps/rallar-monitor` as a Vite React app.

Deliverables:

- package scripts
- TypeScript config
- Vite aliases
- app shell
- route/view skeleton
- empty operational overview

### Iteration 3: Monitor API Contract

Define REST and WebSocket contracts before building real screens.

Deliverables:

- TypeScript DTOs
- query parameter types
- notification envelope
- mock data fixtures
- contract tests for serialization and pagination metadata

### Iteration 4: Data Fetch Layer

Add the client-side data access layer.

Deliverables:

- REST client
- TanStack Query setup
- query key conventions
- pagination helpers
- time window and dimension filter state
- WebSocket notification client that invalidates affected queries

### Iteration 5: Overview Dashboard

Build the first useful screen.

Deliverables:

- active run count
- recent failure count
- production health cards
- current WebSocket/session/room counts
- small trend charts
- last update and stale-data indicators

### Iteration 6: Black-box Run Explorer

Use `rallar-bb-test` vocabulary to display test runs and reports.

Deliverables:

- run list
- run detail page
- recipe summary
- command timeline
- RTC/WS/HTTP result breakdown
- report and diagnostics panels

### Iteration 7: Time-series Metrics Explorer

Add the first metric charts.

Deliverables:

- metric selector
- time window selector
- server-side bucket selection
- Apache ECharts renderer
- latency, volume, failures, reconnects, and peer-count charts

### Iteration 8: Graphology/Sigma Topology View

Add topology introspection.

Deliverables:

- graphology topology builder
- Sigma.js topology renderer
- filters for environment, run, room, transport, and failure state
- node and edge detail panels

### Iteration 9: Production Live View

Add production-focused monitoring.

Deliverables:

- live session overview
- room and topic activity
- WebSocket connection activity
- API health drill-down
- production event stream with cursor pagination

### Iteration 10: Insights And Annotations

Add durable knowledge capture.

Deliverables:

- insight list
- create/edit insight
- link insight to run, metric, topology node, or production window
- status and tag filters

### Iteration 11: Comparison Views

Compare black-box test behavior with production behavior.

Deliverables:

- test versus production topology comparison
- test coverage gaps from production signals
- latency and failure comparison by transport
- run regression comparison against previous runs

### Iteration 12: Scale And Retention

Harden the app and API for large data volumes.

Deliverables:

- server-side rollups
- retention policy display
- downsampling rules
- query cancellation
- response truncation warnings
- virtualized event tables
- load testing for large runs and busy production windows

## Concerns

The monitor should avoid becoming a second control plane. Read and analysis should be the first responsibility.

REST responses can become large quickly. The API must support aggregation, downsampling, cursors, and clear response limits from the start.

WebSocket notifications should not carry bulk metric data unless a specific low-volume alert needs it.

Production telemetry may include sensitive actor, session, room, or message metadata. The API should redact or aggregate before data reaches the browser.

Graph visualisation can become noisy. The topology model should support filtering and progressive disclosure before we add complex rendering.

Black-box test reports and production telemetry need a shared vocabulary, but they should keep their source identity. Test failures and production incidents are related signals, not the same thing.

## Open Questions

- Should the monitor API live in `apps/api-v1`, a new monitor service, or both behind the same contract?
- What server-side storage should back historical metrics and run reports?
- Which production events are safe to expose to browser users?
- Should Rallar production telemetry be pushed into the monitor store directly or derived from existing Rallar runtime state?
- Should Apache ECharts be the only charting dependency initially, or should dense panels start with uPlot?
- What minimum retention is needed for run comparison and production trend analysis?

## References

- TanStack Query: https://tanstack.com/query/
- Graphology: https://graphology.github.io/
- Sigma.js: https://www.sigmajs.org/
- Apache ECharts time axis: https://echarts.apache.org/handbook/en/concepts/axis/
- uPlot: https://leeoniya.github.io/uPlot/
- Recharts: https://recharts.github.io/
