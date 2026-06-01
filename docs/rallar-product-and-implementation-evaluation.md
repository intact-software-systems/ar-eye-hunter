# Rallar Product And Implementation Evaluation

Date: 2026-06-01

This document evaluates the current Rallar and Rallar Server implementation as a product, not only as a set of source
files. It is based on the package-wide source inventory, the primary browser/server facades, the root Rallar docs,
server repository docs, black-box testing docs, app integrations, and the focused tests around the public facade
surface.

## Evaluation Frame

A useful evaluation of this kind should answer five questions:

1. What is the product promise?
2. What are the public surfaces a user is expected to touch?
3. How much of that promise is implemented, tested, documented, and used by real apps?
4. Where does the implementation still expose internal machinery or operational risk?
5. What should be hardened next to make the product easier to adopt?

For Rallar, that means evaluating four layers together:

- Browser SDK: `packages/shared-web/browser/rallar.ts`.
- Browser local data: `packages/shared-web/browser/rallar-data.ts`.
- Server SDK and middleware: `packages/shared-server/rallar-facade/RallarServer.ts`,
  `packages/shared-server/rallar-facade/RallarServerApplication.ts`,
  `packages/shared-server/rallar-system/middleware/RallarMiddleware.ts`, and
  `packages/shared-server/rallar-facade/ws-topic-router.ts`.
- Product examples and verification: root `docs/`, `apps/api-v1`, `apps/rallar-black-box`,
  `apps/relic-hunter-server-v1`, `packages/shared-test`, and `packages/tests`.

## Executive Summary

Rallar is no longer just an experiment. The browser facade has a broad, coherent product surface for auth, rooms, people,
WS messages, RTC messages, realtime data channels, media, and browser IndexedDB data. The implementation is deep and the
docs already describe the main workflows.

Rallar Server is also real, but it is less turnkey. The reusable facade wraps topic routing, middleware installation,
server app data, and route mounting, while the actual production-shaped runtime still lives in `apps/api-v1` with
Postgres, Hono routes, auth, state services, CORS, timing, pub/sub, and expiry wiring.

The strongest evidence of product maturity is not only the code. It is the black-box testing ecosystem:
`apps/rallar-black-box`, `packages/shared-test/rallar-bb-test`, and `packages/shared-test/black-box-runner` form a
visible command center, browser-agent protocol, distributed-run contract, runner recipes, live browser providers, and
artifact model. That is unusually strong for a realtime middleware product.

The main product risk is conceptual weight. Rallar wraps a sophisticated AL/QueueBox/WebSocket/WebRTC/state-sync system,
but some public APIs and examples still require callers to understand room refs, application/workspace scope, topics,
type IDs, fanout, sessions, queue engines, tickets, and state snapshots. The next product step should reduce the number
of concepts required for the first successful app.

As of this evaluation, the implementation is best described as an internal beta for the browser SDK and test platform,
and an alpha-to-beta server SDK. It is powerful enough to build real applications, but not yet packaged as a low-friction
external developer product.

## Package Map

| Package | Current role | Product interpretation |
| --- | --- | --- |
| `packages/shared` | Core AL contracts, queuebox, command orchestration, repositories, persistence, WebSocket, WebRTC, multicast, cache, resilience, and demo engines. | The runtime substrate. It is powerful but intentionally not the product entry point. |
| `packages/shared-web` | Browser middleware, REST workflows, WebSocket/RTC engines, state caches, `rallar.ts`, and `rallar-data.ts`. | The main browser SDK. This is the clearest Rallar product surface. |
| `packages/shared-server` | Server middleware, server facade, dynamic WS topic router, app data facade, repository contracts, Postgres adapters, auth/state services, timing hooks. | The reusable server SDK plus current concrete Postgres implementation. |
| `packages/shared-test` | Black-box runner, browser providers, `rallar-bb-test` command schema/runtime, distributed-run contracts, artifacts, provider parity. | A serious test product for Rallar and Rallar Server. |
| `packages/shared-graph` | Graph, tree, mesh, Vivaldi, and removal dynamics services. | Supporting topology layer for RTC overlays and diagnostics. |
| `packages/relic-hunters` | Domain model/protocol/rules for a demo game. | A product example proving Rallar can carry app-specific state and WS topics. |
| `packages/tests` | Vitest coverage across browser facade, server facade, middleware, black-box app, shared-test, graph, and core runtime. | Confidence layer and executable specification. |

## Product Surface Today

### Browser Rallar

The browser facade exposes a single grouped interface:

- lifecycle: `configure`, `setDefaults`, `connect`, `start`, `disconnect`, `status`, `session`
- auth: login, register, register-and-login, logout, restore
- rooms: state, list, refresh, create, join, leave, current, change listeners, event listeners, event replay
- people: state, list, refresh, get, change listeners, event listeners, event replay
- messages: WS lane, RTC lane, and typed channels
- RTC: status, lifecycle, peer readiness, room-lane waits
- WS: status, lifecycle, wait-for-open
- realtime: JSON/binary data-channel send/listen, typed JSON lane, lane health
- media: local stream, audio/video toggles, remote streams
- data: browser local stores through Rallar Data
- advanced: escape hatch to lower-level middleware

The design is good: most user operations are grouped by intent, and `start()` offers a clear app boot path. The
documentation in `docs/rallar-api-reference.md`, `docs/rallar-quickstart-and-recipes.md`, and
`docs/rallar-ai-skill.md` explains the happy paths and common mistakes.

The implementation also contains important production details:

- single-flight `connect()` behavior
- explicit defaults for application/workspace/room/realtime/operation policies
- operation timeouts and retries through command orchestration
- session-aware reconnect and logout cleanup
- state cache hydration and change events
- persisted event listing and replay with dedupe
- WS and RTC lifecycle/status callbacks
- roomRef-aware RTC/WS/realtime operations for multi-workspace correctness
- direct RTC realtime lanes plus app-level AL messages over both WS and RTC
- media stream management over RTC peers

Maturity: high internal maturity. The main issue is not missing capability, but discoverability and conceptual load.

### Rallar Data

`rallar-data.ts` is a separate browser-local data product inside the Rallar facade. It gives browser code scoped
IndexedDB-backed stores with:

- `define`, `open`, `lookup`, `close`, `clearScope`, `destroy`, `estimateUsage`
- scoped storage: `app`, `principal`, `session`, or custom scopes
- write-through and write-behind durability modes
- eager or lazy hydration
- schema versions and migrations
- TTL and expiry support
- change listeners
- cross-tab sync through `BroadcastChannel`

This is a credible local-state abstraction for drafts, settings, offline UI state, and local runtime state. Tests cover
persistence, rehydration, isolation, migrations, incompatible option rejection, BroadcastChannel sync, and scope
cleanup.

Important product caveats:

- `compareAndSet` is a convenience over current facade state, not a transactional cross-tab lock.
- BroadcastChannel sync is same-origin active-tab coordination, not durable sync.
- Opening the same store with different options intentionally throws, which is good, but callers need examples showing
  stable definitions.

Maturity: strong for browser-local state. It should be documented as local persistence, not as server synchronization.

### Rallar Server

`RallarServer.ts` is a composition facade. It exposes:

- `server.system.useDefaultMiddlewareTopics()`
- `server.system.useWebSocketLifecycle()`
- `server.ws.install()`, `defineTopic`, `on`, `proxy`, `publish`, `status`
- `server.data.open(...)` for server app-data stores
- `server.start()` to start the queuebox engine

`RallarServerApplication.ts` adds route mounting:

- `server.ws.mount(app)`
- `server.rest.mount(app)`
- idempotent route installer behavior

The server facade is small, which is a strength. Most real behavior lives in reusable lower layers:

- `RallarMiddleware.ts` constructs the queuebox engine, WebSocket server service, inbox reader, app inbox services,
  target resolver, AL runtime stores, RTC signaling paths, and state repositories.
- `ws-topic-router.ts` handles dynamic `app.*` and `room.*` topics with validation, handler dispatch, proxy rules,
  max payload checks, room authorization, live-only fanout, durable outbox fanout, and NACKs.
- `RallarServerAppData.ts` provides server-side JSON app-data stores with namespace/keyPrefix/schema/TTL/migration
  support.
- Postgres adapters currently back queuebox, runtime state, AL runtime state, and app data.

The concrete API product is still `apps/api-v1`. `create-rallar-server.ts` injects middleware, default topics,
lifecycle cleanup, route installers, room authorization, repositories, and Postgres app data. `middleware.ts` wires
Postgres queuebox, resource inbox repositories, runtime-state expiry, AL runtime stores, state services, state sync,
Postgres pub/sub, timing, and presence reconciliation.

Maturity: powerful and well-factored for the current app, but still not turnkey. A new server app must understand more
setup than the browser quickstart suggests.

### Rallar Black Box

`apps/rallar-black-box` is effectively a companion product:

- visible SPA for direct Rallar operations
- simulated and real `browser-rallar` provider modes
- auth, groups/clients, WebSocket, RTC/realtime, data, media, server REST, trace, topology, diagnostics
- manual workbench and flow builder
- control-server run manager and distributed recipes
- remote browser-agent orchestration
- full-stack QA matrix and live three-browser RTC coverage

The black-box runner stays intentionally provider-neutral: HTTP, WS, RTC, ASSERT, SET, recipes, artifacts, and provider
adapters. The docs repeatedly reinforce that it should not become a second Rallar implementation. That boundary is
healthy.

Maturity: high as an internal validation and operator tool. For external users, it needs positioning: "test command
center" rather than "how you build apps."

### Application Examples

`apps/api-v1` is the canonical Rallar Server runtime. It proves the middleware can run with REST, WebSocket, auth,
state sync, Postgres persistence, Swagger, CORS, timing, and lifecycle cleanup.

`apps/relic-hunter-server-v1` is the best product-shaped example. It creates a Rallar server, opens server app data,
defines a room-scoped WS command topic, handles commands, stores game state, and publishes snapshots. The example shows
how an application can use Rallar Server without becoming a Rallar internals project.

`apps/rallar-black-box` proves operational and distributed testing workflows, but it is too large to be the first
developer example.

## What Is Implemented Well

1. A high-level browser facade exists and covers the expected realtime app needs.
2. The browser API is grouped by user intent instead of by transport internals.
3. There is a meaningful server facade, not just loose middleware functions.
4. Server dynamic topics have validators, authorizers, handlers, proxy rules, fanout modes, and NACK behavior.
5. Browser and server custom data stores exist and share similar ergonomics.
6. Scope and `GroupRef` hardening work is already underway and documented.
7. The black-box testing stack is unusually complete for a realtime middleware project.
8. Docs already include quickstart, API reference, troubleshooting, AI guide, and prompting guide.
9. Tests cover a broad set of behavior: facade operation options, message selectors, data stores, server app data,
   server route mounting, WS topic routing, middleware target resolution, black-box operations, and distributed-run
   contracts.
10. Operational evidence is first-class: traces, status APIs, lifecycle callbacks, timing events, redacted artifacts,
    diagnostics, and QA matrices are all present.

## Main Product Gaps

### 1. The First App Path Is Still Too Heavy

The browser quickstart is clear, but the full mental model is large. A new user quickly encounters auth sessions,
application/workspace scope, groups/rooms, room refs, WS tickets, topic IDs, type IDs, realtime lanes, RTC readiness,
fanout, snapshots, and event replay.

Recommended product fix:

- Add a "smallest real app" guide with one room, one typed channel, one presence view, and one fallback path.
- Add a "concepts in one page" doc that defines session, room, roomRef, topicId, typeId, lane, and fanout.
- Keep AL/QueueBox details out of beginner docs.

### 2. Browser Facade Size Creates Maintenance Risk

`rallar.ts` is a large facade implementation. The grouped API is good, but the single file now owns lifecycle, auth,
rooms, people, WS, RTC, realtime, media, event replay, status mapping, defaults, callback registration, and send
construction.

Recommended product fix:

- Keep the public `RallarFacade` stable, but split implementation modules by domain.
- Add internal domain tests per module while preserving public facade tests.
- Treat `advanced.middleware()` usage as a signal that the facade is missing a product operation.

### 3. Rallar Server Is Not Yet A Turnkey Server Product

`RallarServerApplication` is clean, but `apps/api-v1/src/middleware.ts` shows the real amount of setup: Postgres
queuebox, resource inbox results, runtime state, AL stores, app inbox services, state sync, pub/sub, timing, expiry,
presence reconciliation, CORS, auth middleware, and routes.

Recommended product fix:

- Add a "server preset" or `createDefaultRallarServer(...)` builder for the common Postgres/Hono path.
- Add an in-memory/dev repository preset for local tests and performance experiments where durability is not required.
- Document which dependencies are mandatory, optional, and production-only.

### 4. Persistence Is Abstracted But Postgres Is Still The Concrete Center

Repository interfaces exist, and `RallarServer.data` can inject a different app data repository. Still, API-v1 and the
current middleware path are Postgres-shaped. This is reasonable for production durability, but it limits cheap
performance testing and lightweight demos.

Recommended product fix:

- Keep Postgres as the production adapter.
- Introduce explicit in-memory adapters for QueueBox, runtime state, app data, auth, clients, and groups.
- Make the adapter choice a visible server configuration option.
- Document the guarantees that are lost in memory mode: no multi-process durability, no crash recovery, and limited
  cross-instance coordination.

### 5. Server App Data Is Useful But Not Fully Durable-Concurrency-Safe

Server app data stores persist through a repository and keep a process-local cache. Methods like `setIfAbsent` and
`compareAndSet` are read-modify-write conveniences, not database-level atomic compare-and-swap. The Relic Hunter server
handles this by serializing writes per game in application code.

Recommended product fix:

- Document this explicitly in server app-data docs.
- Consider repository-level atomic operations if server app data becomes a recommended state store for games or
  collaborative apps.
- Provide a standard keyed mutation queue helper if process-local serialization is the intended pattern.

### 6. Dynamic WS Topic Naming Rules Need Product-Level Framing

The server router reserves `rallar.*` and only allows user topics under `app.*` or `room.*`. This is good, but users
need to learn it early. The black-box direct operations already validate this before loading the facade, which proves
the rule is product-facing.

Recommended product fix:

- Add a short "Topic Design" doc with examples:
  - `app.cursor`
  - `room.chat`
  - `room.game.command`
  - reserved `rallar.*`
- Explain when to use `live-only`, `outbox`, or `none`.

### 7. Product Positioning Is Split Across Many Docs

The docs are strong, but they are mostly API/reference/runbook oriented. The product needs one opinionated entry path:
"Use Rallar when..." and "Do not use Rallar when..."

Recommended product fix:

- Add `docs/rallar-product-overview.md`.
- Add a decision table for WS vs RTC messages vs realtime data channel vs REST.
- Link the black-box app as validation tooling, not as the default app-building tutorial.

## Product Maturity Scorecard

| Area | Current maturity | Evidence | Main next step |
| --- | --- | --- | --- |
| Browser facade | Internal beta | Complete grouped facade, docs, focused tests, app usage. | Reduce conceptual load and split implementation modules. |
| Browser data | Internal beta | IndexedDB persistence, migrations, BroadcastChannel sync, scope cleanup tests. | Document local-only guarantees and stable definitions. |
| Server facade | Alpha/beta | Small facade, app wrapper, dynamic topics, app data, tests. | Add a turnkey server preset and clearer setup docs. |
| Server middleware | Internal beta | Durable QueueBox, state sync, auth/state services, target routing, Postgres adapters. | Add dev/in-memory adapter mode and production hardening checklist. |
| Dynamic WS topics | Beta | Validators, handlers, proxies, fanout, NACKs, room authorization tests. | Add topic design docs and examples. |
| App data server store | Alpha/beta | JSON stores, TTL, migration, Postgres adapter, Relic Hunter usage. | Clarify concurrency model and optionally add atomic operations. |
| Black-box testing | Beta | SPA command center, shared schemas, runner, remote provider, distributed-run contracts, live matrix docs. | Package operator docs and keep runner boundary clear. |
| External developer readiness | Alpha | Docs exist, examples exist, but setup and concepts are broad. | Build one polished "first real app" journey. |
| Production operations | Alpha/beta | Timing events, traces, lifecycle callbacks, artifacts, expiry jobs. | Add deployment/runbook presets and health dashboards. |

## Recommended Roadmap

### Near Term

- Create a product overview and concept map.
- Add a minimal real app tutorial using one typed channel and one room.
- Add a server quickstart that hides API-v1 wiring behind a preset.
- Add explicit docs for topic naming and fanout.
- Document concurrency limits of browser/server data `compareAndSet`.
- Add an in-memory single-process server mode for local testing and cheap performance runs.

### Medium Term

- Split the browser facade implementation internally while preserving the public API.
- Promote Relic Hunter server as a compact app integration example.
- Add package-level public API stability notes.
- Add a deployment checklist for API-v1/Rallar Server.
- Add a health endpoint or dashboard that aggregates WS status, queue depth, state-sync health, and app inbox timing.

### Later

- Consider a dedicated `shared-postgres` adapter package if non-Postgres adapters become real.
- Add atomic repository operations for server app data if app data becomes a recommended authoritative state store.
- Publish a compatibility contract for black-box command schemas and Rallar facade versions.
- Decide whether Rallar Server is primarily a library, a reference server, or a hosted product shape.

## Product Conclusion

Rallar has the bones of a real realtime application platform:

- a browser SDK that hides most transport machinery
- a server SDK that can route, validate, authorize, fan out, and persist
- durable state and event replay
- WebSocket and WebRTC paths
- local browser and server app data
- operational visibility
- a distributed black-box testing system

The current state is strong for internal use and advanced early adopters. The product work ahead is mostly about
shrinking the first-use surface, packaging server setup, clarifying guarantees, and deciding which concepts are public
product vocabulary versus implementation vocabulary.

The best product framing today is:

> Rallar is a browser and server facade for realtime room-based applications, with built-in auth/session integration,
> state sync, WebSocket messages, WebRTC messages, low-latency data channels, local data stores, server app data, and a
> companion black-box testing platform.

That framing is accurate, valuable, and close to what the implementation already delivers.
