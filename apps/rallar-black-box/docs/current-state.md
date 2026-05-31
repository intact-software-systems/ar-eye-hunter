# Current State

`apps/rallar-black-box` is currently a deployable Vite/React SPA for visible black-box test operation and remote browser
agent orchestration. It is built around the shared `packages/shared-test/rallar-bb-test` facade so recipes, local UI
actions, remote control commands, runtime events, stats, and reports use one command vocabulary.

## Implemented

The SPA implementation is complete through command-center Iteration 38: the first full-stack harness, real-payload
delivery slices, reload-safe UI draft persistence, shared-test bridge, Auth command center, Groups/Clients command
center, REST collections, WebSocket command center, scoped RTC delivery matrix, Flow Builder, control-server Run
Manager, control-run artifact export, full-stack QA matrix, large-run event/topology controls, and live three-browser
RTC matrix baseline are in place. The
shared-test runner and command-center handoff
work is complete through Iteration 19 in
`packages/shared-test/rallar-shared-test-gap-analysis.md`.

The shared facade exists in `packages/shared-test/rallar-bb-test` and defines:

- command types for `configure`, recipes, RTC, WebSocket, HTTP, health, stats, close, and reset
- runtime state, command results, events, stats snapshots, and report fragments
- redaction helpers and UI selectors
- result replay by stable command ID
- browser adapter code for fetch, WebSocket, and existing browser Rallar runtime shapes
- runner adapters, including the `rallar-remote-browser` provider
- provider-parity helpers that build portable SPA recipes, convert them to `rallar-browser` or `rallar-remote-browser`
  runner interactions, and normalize SPA/runner reports for comparison

The shared-test runner now provides the external JSON recipe layer for HTTP, WS, and RTC testing:

- recipe matrix profiles for quick, dry-run, deterministic, live, strict-live, scale, soak, traffic, and parallel runs
- deterministic `rallar-memory` coverage for delivery semantics, routing failures, same-connection soak, seeded traffic
  replay, and bounded parallel groups
- gated `rallar-browser` and `rallar-remote-browser` recipes for live soak, seeded traffic, and parallel RTC patterns
- redacted artifact bundles with `report.json`, `events.jsonl`, `failures.json`, `metadata.json`, optional
  `expanded-plan.json`, and optional `matrix-summary.json`
- a browser-safe command-center handoff contract, fixture recipe catalog, artifact parser, versioned schema fixtures,
  and compatibility validation

The SPA currently provides:

- local workbench startup with a sample recipe
- URL and Vite-env bootstrap for control-agent mode
- WebSocket control client with registration, heartbeat, reconnect, command dispatch, duplicate result replay, stats, and
  final report streaming
- visible panels for configuration, recipes, command queue, active command, command history, events, stats, failures, and
  report JSON
- authenticated login gate for `browser-rallar` mode with browser-session restore and logout cleanup
- tabbed operational shell split into direct `Rallar` tabs (`Quick Test`, `Auth`, `Groups/Clients`, `WebSocket`,
  `RTC/Realtimes`, `Topology`, `RTC Diagnostics`, `Rallar Data`, `Media`, `Rallar Server`, `Rallar Trace`, and
  `Event Stream`) and
  black-box-runner tabs (`Shared Test`, `Manual Rallar`, `Local Workbench`, `Flow Builder`, `Run Manager`, and
  `Event Stream`)
- global command-center context above the tabs for API base URL, application, workspace, room/group, client, and session;
  login populates client/session and the context seeds Quick Test, Manual Rallar, Groups/Clients, WebSocket, RTC
  Diagnostics, and Rallar Server, plus Flow Builder variables before they are manually edited
- always-visible Rallar Browser Trace strip for signaling WebSocket status, RTC status, active group, peer counts, and
  the latest `rallar.browser.*` events emitted by the browser-side Rallar runtime during real-provider auth, RTC
  signaling/connect, send, cleanup, and error paths, with a `Rallar Trace` drill-in for full event payloads and failure
  messages
- Auth command center for login, register-and-login, restore, logout, local session clear, active session/client/token
  evidence, session/ticket TTLs, WS-ticket creation, bad-credentials checks, missing-auth-ticket checks,
  expired-session ticket checks, redacted diagnostics, and auth recipe snippets
- Groups/Clients command center for reusable state variables, direct Rallar room refresh/create/join/leave actions,
  group/client/presence/event REST actions, group and client state tables, optional online/member filters, room/client
  sorting, state event rows, current-client/other-browser membership assertions, expected/observed/missing client
  metrics, cleanup actions, and state recipe snippets
- WebSocket command center split into `Rallar WS Messages` for direct app-level `rallar.messages.ws.*`
  send/subscribe/wait
  flows and `Raw WebSocket Diagnostics` for ticket/socket configure/open/reconnect/close/cleanup checks, with
  a default room-scoped group-message preset that follows the joined/global group, group/type/topic scoped
  app-message sends, explicit browser-rallar `Subscribe WS` receive wiring, route previews for preset
  destination/selector/transport, a dedicated received-message panel with visible listening status,
  authenticated API-v1 ticket creation, browser-rallar room-scoped subscribe joining, signaling-socket
  `rallar.messages.ws.send(...)` delivery for Rallar app WS envelopes without using `browser-rallar-runtime.ts`,
  missing-ticket negative checks, status/event diagnostics, payload presets, and WS/RTC comparison recipe snippets
- persistent global header state for provider, control, runtime, room, active command, first failure, user, and session
- top-level workspace mode switch for direct `Rallar` operations versus `Rallar black-box-runner` recipes/control
  runs/artifacts; the mode is stored in `workspace` and existing `tab` deep links infer the correct workspace
- direct Rallar operation boundary with a facade-backed `status.check` action, explicit real-backend-required state for
  simulated provider mode, and `rallar.direct.*` diagnostics in the trace/event stream
- default Rallar-mode Quick Test flow for real WS group data: create/join a group using the current Group text as the
  explicit Rallar group ID, subscribe this browser with `rallar.messages.ws.onMessage(...)`, send JSON through
  `rallar.messages.ws.send(...)`, wait for receives, inspect sender/group/type/topic/context/resource details, and copy
  redacted diagnostics
- RTC/Realtimes console for direct `realtime.sendJson`, `realtime.onJson`, `messages.rtc.send`,
  `messages.rtc.onMessage`, room-lane waits, lane health, received-message display, phase timing events, and RTC
  runner-recipe export; interactive `messages.rtc` sends default to `best-effort`, while repeated actions skip the
  group join when the current browser session is already active in the selected group
- Rallar Data console for scoped stores, store lifecycle, read/write/update/CAS/delete/export/usage operations,
  change-event display, scope cleanup, and copyable diagnostics
- optional Media console for local stream attach, audio/video toggles, stop controls, media policy, remote stream
  events, and copyable diagnostics
- authenticated Rallar Server REST workbench with endpoint presets, raw request editing, auth header injection, response
  rendering, explicit request lifecycle feedback for sending/success/failure, Rallar Trace request events, cURL export,
  black-box `http.request` command export, and actions that promote response group/client/session values into Global
  Context for Quick Test
- REST collections in the Rallar Server tab with persisted collection/variables JSON, built-in group/client/negative
  templates, variable substitution, JSON-path extraction, status/body/header assertions, redacted collection export, and
  black-box recipe export
- live full-stack Rallar Server coverage for login, create-or-existing group setup, group join with the authenticated
  client ID, missing-body `400 Bad Request` evidence, and principal-mismatch rejection evidence
- Flow Builder workspace for composing auth-shaped REST, server REST, WS, RTC, wait, and cleanup steps with variables,
  editable flow JSON, SPA recipe export, runner scenario export, and inline `recipe.run` execution
- Run Manager workspace backed by the control server for listing bounded run snapshots, selecting agent groups,
  enqueueing bulk commands, resetting runs, deleting runs, inspecting recent commands/results/events, validating
  exported run artifacts, and copying artifact bundles/events JSONL/results JSONL/failure bundles
- Distributed Recipes workspace for selecting app-local browser-agent recipes, resolving control agents against the
  current Global Context group, building distributed-run manifests, staging, starting, cancelling, refreshing, and
  exporting distributed-run artifacts, including a configurable `rtc-realtime` recipe that sends game-style RTC position
  frames at a target 20 Hz cadence, plus monitor/history/compare views for linked events, failures, ACK readiness,
  per-agent/per-recipe progress, latency summaries, artifact validation, historical filters, and two-run deltas
- full-stack QA coverage ownership in `src/full-stack-qa-matrix.ts`, with skip-gated Playwright specs mapped to auth,
  groups/clients, WebSocket, REST, recipes/artifacts, RTC, control, and resilience evidence
- reload-safe UI persistence for selected tab, selected command, Manual Rallar drafts, Event Stream filters, and Rallar
  Server request drafts
- UI-level redaction for command previews, copied recipes, reports, received payloads, diagnostic bundles, REST response
  text/URLs, command exports, and cURL exports
- gated full-stack Playwright harness for API-v1, control-server, SPA, two-browser REST workbench login,
  control-orchestration smoke coverage, and a UI-driven Manual Rallar realtime payload delivery check
- manual Rallar workbench for quick configure, join, connect, send, health, close, reset, scoped RTC, realtime/
  `messages.rtc` delivery matrices, and NACK probe actions
- browser-rallar `rtc.send` command results now fail when the browser runtime reports no peers, no RTC route, failed
  data-channel sends, or protected enqueue failures
- real-provider Manual Rallar `Create and join group` creates a Rallar Server group before RTC connect, so disposable
  test rooms can be created directly from the UI flow
- received-data inbox derived from runtime message events
- RTC diagnostics panel for connect phases, expected/observed/ready/active/missing/stale peers, lane health, NACK codes,
  latency, failure focus, and copyable diagnostic bundles
- topology view derived from runtime events using graphology and rendered with Sigma.js
- Event Stream windowing for 40/100/250/500 matching events and Topology search/node limits plus deterministic route
  summaries for larger runs
- a Provider Parity recipe fixture for connect, direct send, multicast metadata, broadcast metadata, health, close, and
  reset checks
- a browser-safe re-export of the shared-test recipe catalog, artifact contract, coverage handoff, artifact parser,
  schema validators, command capabilities, and generated command examples used by the command-center authoring UI
- schema-driven authoring feedback in Local Workbench, Manual Rallar exports, Run Manager command JSON, Flow Builder
  exports, and Distributed Recipes manifests/catalog entries
- `Shared Test` workspace for app-local recipe discovery, shared-test fixture catalog browsing, copyable runner
  commands, coverage ownership, and validated runner artifact bundle import
- a gated live three-browser full-stack baseline that uses real `browser-rallar` agents to create/join an isolated
  group, run direct/multicast/broadcast delivery over `realtime` and `messages.rtc`, probe not-yet-in-sync/NACK
  behavior, prove closed-transport failure, reject fake-provider topics, and validate control-server artifacts
- an exhaustive live three-browser all-scenarios gate for REST group readback, WS open/send/close from every agent, all
  direct sender/receiver pairs, all sender multicasts, all sender broadcasts, unexpected-delivery checks, stale-send
  failure, reconnect-after-stale-agent, and artifact validation

The control server in `apps/rallar-black-box-control-server` currently provides:

- `GET /health`
- `POST /retention/cleanup`
- `GET /runs` with bounded snapshot query parameters
- `GET /runs/:runId` with bounded snapshot query parameters
- `POST /runs/:runId/commands` for bulk enqueue to selected agents
- `POST /runs/:runId/reset`
- `DELETE /runs/:runId`
- `GET /runs/:runId/artifacts`
- `GET /runs/:runId/artifacts/:fileName`
- `GET /runs/:runId/events.jsonl`
- `GET /runs/:runId/results.jsonl`
- `GET /runs/:runId/failure-bundle`
- `POST /runs/:runId/agents/:agentId/commands`
- `POST /runs/:runId/agents/:agentId/report`
- `POST /runs/:runId/agents/:agentId/tokens`
- `GET /control` as the WebSocket upgrade endpoint for browser agents

The control server is intentionally local-first. It is useful for local orchestration, smoke tests, and protocol
development. It stores runs in memory by default and can persist/reload snapshots when
`RALLAR_BLACK_BOX_STORAGE_DIR` is set. `RALLAR_BLACK_BOX_RETENTION_MAX_RUNS` can prune older local runs. Monitor-server
ingestion remains a separate backend concern.

## Runtime Reality

The SPA runtime store defaults to the local/fake command executor from `src/runtime-store.ts` for black-box-runner
workflows and offline UI work. That executor emits realistic command results, diagnostics, message events, stats, and
topology inputs for runner surfaces. Direct `Rallar` mode tabs call `@shared-web/browser/rallar.ts` or Rallar Server
REST APIs directly. The `src/browser-rallar-runtime.ts` bridge remains for runner-owned command execution, such as the
Manual Rallar scratchpad and imported recipes, not for direct Rallar-mode WebSocket/RTC/Data/Media actions. The local
sample recipe bootstrap and `Replay Sample` control are also runner-only, so opening the default Rallar workspace does
not execute the fake black-box runtime scaffold.

The client has complete local defaults in `src/client-defaults.ts`:

- provider mode: `simulated`
- control URL: `ws://localhost:5180/control`
- local run ID: `local-workbench-run`
- control run ID: `control-run-local`
- agent ID: `visible-agent-local`
- environment: `local`
- API base URL: `https://api.example.invalid`
- actor: `alice`
- session ID: `visible-session-alice`
- room/group ID: `rallar-black-box-room`
- transport: `realtime`
- connection: `aliceRtc`
- WebSocket URL for manual examples: `wss://control.example.invalid/runs/manual`
- timeout: `5000` ms

No login is required for the local UI. The demo username, password, and token values exist so the simulated provider,
redaction, diagnostics, and reports can exercise credential-shaped config. Real credentials are only used when
`provider=browser-rallar` is explicitly selected.

Provider mode is explicit. `simulated` mode is the default. `browser-rallar` can be selected through URL or Vite env
config and requires a real Rallar API base URL plus username/password or a restorable browser auth session. The visible
SPA now shows a login screen for `browser-rallar` when no session is restored. A bare token is not currently enough for
the SPA provider; restored-session mode expects a complete browser auth session in local storage.
Real-provider close/reset cleanup unsubscribes browser listeners, leaves the joined room by default, disconnects or logs
out when `rallarLogoutOnClose=1`, and records cleanup diagnostics. Remote reset commands also clear browser
`localStorage` and `sessionStorage` on a best-effort basis.

The app shell is tabbed. The active tab is stored in the `tab` query parameter and in local browser storage, so a fresh
load without `tab` returns to the last selected workspace. Inactive tab panes remain mounted while hidden, so manual form
edits, recipe JSON, selected commands, topology filters, and event filters survive normal navigation. Selected command
ID, Manual Rallar values/payload draft, Event Stream filters, and Rallar Server request drafts also survive reloads.
Secret-shaped draft fields are not stored raw: Manual Rallar passwords are stripped, JSON editor drafts are redacted, and
invalid JSON editor drafts are dropped instead of being persisted with possible secrets.

The `Rallar Server` tab can call API v1 REST endpoints directly from the browser. It starts from curated
OpenAPI-derived presets, can refresh endpoint rows from `/api/openapi.json`, injects the active browser auth session
when requested, redacts access tokens in visible exports, and can copy the selected request as a redacted black-box
`http.request` command or cURL command. A request feedback strip shows whether the latest request is idle, sending,
successful, or failed, including endpoint, status, duration, and the classified error message. Each single request also
emits `rallar.server.rest.request.*` trace events so failures can be inspected in `Rallar Trace` with the full redacted
payload and response body.

The same tab now has a REST Collection area for repeated server checks. Collections are editable JSON, use named
variables, substitute placeholders in request fields, extract response values into later variables, evaluate expected
status/body/header assertions, and export as black-box `http.request` recipes with assertion metadata.

The `Flow Builder` tab provides the first visual composition surface across HTTP, WS, RTC, waits, and cleanup. It uses
the same `rallar-bb-test` command vocabulary for SPA recipe execution and can export a black-box-runner-style scenario
for local runner work.

The `Auth` tab turns login/session behavior into a repeatable manual workflow. It can create or restore sessions, create
WS tickets, run basic negative auth checks, show redacted session/ticket state, and copy an auth recipe snippet.

The `Groups/Clients` tab turns group, client, session, presence, and state-event endpoints into one live state view. It
uses the active auth session for API-v1 state calls and displays server evidence beside runtime expected/observed client
diagnostics. The group and client tables now include local filters for groups with members and online clients plus
sorting by activity, mutation time, creation time, counts, status, or name.

The default `Quick Test` tab is the shortest real-data path in Rallar mode. It uses Global Context for API base URL,
application, workspace, and group; can create-and-join or join a group through the browser Rallar facade; subscribes the
current browser to room-scoped WS messages; sends JSON to the group; waits for a new receive; and shows received payloads
with sender, group, type, topic, context, and resource metadata. Create-and-join passes the typed Group value as the
explicit Rallar group ID, so Global Context stays on the value the tester selected. It requires `provider=browser-rallar`;
simulated mode shows an explicit real-backend-required state.

The `WebSocket` tab is a focused command-center workflow for Rallar WS messages. In `browser-rallar` mode, `Send JSON`
applies the current command-center config and sends Rallar-shaped group/all/world payloads through
`rallar.messages.ws.send(...)`, connecting the browser facade first if needed. `Subscribe WS` also connects signaling
and joins the selected group for room scope before reporting `listening`, so the receive panel reflects a real app-level
WS subscription. The lower-level raw WebSocket diagnostics are socket/ticket checks and do not use
`browser-rallar-runtime.ts`; repeatable raw WS flows belong in copied recipes or black-box-runner mode. Browser Rallar
signaling uses one-time API-v1 WS tickets and fetches a fresh ticket for every new socket connection or reconnect.

This means the current app is already useful for:

- validating the command contract
- validating control-server orchestration
- testing result replay and reconnect behavior
- debugging the visible UI flow
- exercising diagnostics, report, received-message, and topology surfaces
- building repeatable recipes from manual actions

It has gated real-provider smokes for one-agent connect/send, two-agent delivery, Manual Rallar realtime delivery, and a
three-browser RTC delivery matrix. Those smokes are skipped unless a real Rallar environment is configured. Auth,
permission, stale-session, duplicate-session, and cleanup failures now emit specific diagnostics and appear in the
copyable RTC failure bundle.

Manual Rallar now passes `applicationId`, `workspaceId`, `scope`, `roomRef`, and `minSnapshotVersion` through RTC
connect/send commands and generated recipes. The Delivery Matrix can run direct, multicast, and broadcast sends over
both `realtime` and `messages.rtc`, while the NACK probe and negative recipe output provide repeatable starting points
for missing-peer, stale-agent, duplicate-session, permission, closed-transport, and not-yet-in-sync investigations.

The SPA imports shared-test handoff types at build time and renders the browser-safe fixture catalog in the `Shared Test`
tab. Uploaded runner artifact bundles are parsed with `parseRallarBlackBoxSharedTestArtifactBundle(...)` and projected
into imported event stream, RTC diagnostics, failure-focus, summary, and replay-recipe views. The browser still does not
execute shell commands; runner execution remains explicit local tooling or control-server work.

The provider-parity bridge connects visible SPA recipes and runner scenarios. The portable parity helper intentionally
marks provider-specific report fields such as timing, remote agent metadata, browser health, and raw runner `actual`
details so report comparisons focus on shared command/result semantics. The runner conversion omits `configure`,
`health`, and `reset` with explicit reasons because the RTC provider vocabulary only has connect, send, wait, and close
actions.

## Security State

The control boundary already includes the first hardening pass:

- strict command-kind and command-field validation
- command allowlist support on the control server
- command idempotency by command ID and payload fingerprint
- enqueue rate limiting
- request payload-size limits
- optional short-lived run tokens
- optional origin and TLS enforcement
- destination allowlists for remote browser HTTP and WebSocket commands
- redaction of sensitive keys and payloads in runtime reports
- UI-level redaction before displaying or copying command previews, recipes, report snapshots, diagnostics bundles,
  received payloads, REST response text/URLs, REST command exports, and cURL exports
- browser storage cleanup on reset

These checks are necessary because the app is a remote browser-control surface.

## Known Gaps

The main gaps are:

- the default SPA mode is still simulated for offline use
- the live `browser-rallar` connect/send, two-agent delivery smokes, Manual Rallar realtime delivery test, and
  three-browser live RTC matrix are environment-gated and skipped unless real Rallar config plus local full-stack
  services are supplied
- permission-denied, forbidden, expiry, CORS, missing-peer, stale-agent, duplicate-session, and exact server-provided
  NACK assertions still need stable provisioned-environment fixtures
- the control server has optional snapshot persistence, but retention policy, artifact search, and production-grade
  durable storage remain planned; Run Manager reset/delete affects only local control snapshots and connected control
  sockets
- monitor-server ingestion is not connected
- long-running, seeded-traffic, and bounded-parallel runner support exists in shared-test and selected entries are
  visible in the SPA, but full matrix browsing, large-run virtualization, and durable artifact retention are not
  implemented yet
- large run artifact search and retention policy are not implemented
- Flow Builder is implemented for command composition and export, but full shared-runner assertion execution, richer
  recording from other tabs, and durable flow storage are still planned
- auth and permission negative testing is visible in the Auth tab, but expiry/forbidden/CORS matrices still need real
  backend coverage
- rooms and clients have a live state UI, but saved state scenarios and assertions are still planned
- WebSocket testing now has a command-center tab, but expired-ticket, unauthorized socket, server-restart/reconnect, and
  WS-vs-RTC parity matrices still need real-backend automation
- topology is derived from runtime events and now has search/node limits, but it is not yet performance-tested for very
  large event streams
- Event Stream has bounded windows, but true virtualization/cursor pagination and the deeper accessibility/viewport QA
  pass remain future work

## Verification Commands

Focused checks used for the current state:

```sh
npm --workspace rallar-black-box run build
npm --workspace @ar-eye-hunter/shared-test run typecheck
npm --workspace rallar-black-box run typecheck
npm run test -- packages/tests/shared-test/rallar-browser-runtime.test.ts packages/tests/rallar-black-box/rtc-diagnostics.test.ts packages/tests/rallar-black-box/browser-rallar-runtime.test.ts packages/tests/rallar-black-box/control-bootstrap.test.ts packages/tests/shared-test/rallar-bb-test.test.ts packages/tests/rallar-black-box/control-client.test.ts
npm run test -- packages/tests/rallar-black-box/browser-rallar-runtime.test.ts packages/tests/rallar-black-box/control-bootstrap.test.ts packages/tests/shared-test/rallar-bb-test.test.ts
npm run test -- packages/tests/rallar-black-box/topology-graph.test.ts packages/tests/rallar-black-box/rtc-diagnostics.test.ts packages/tests/rallar-black-box/manual-workbench.test.ts packages/tests/rallar-black-box/control-bootstrap.test.ts packages/tests/rallar-black-box/control-client.test.ts
npm run test -- packages/tests/rallar-black-box/app-tabs.test.ts packages/tests/rallar-black-box/auth-flow.test.ts packages/tests/shared-test/rallar-bb-browser-adapter-auth.test.ts
npm run test -- packages/tests/rallar-black-box/rallar-server-workbench.test.ts
npm run test -- packages/tests/rallar-black-box
npm run test -- packages/tests/rallar-black-box/full-stack-qa-matrix.test.ts packages/tests/rallar-black-box/live-rtc-three-browser-coverage.test.ts
npx vitest run packages/tests/shared-test/black-box-runner-artifact-reader.test.ts packages/tests/shared-test/black-box-runner-handoff-contract.test.ts packages/tests/shared-test/recipe-matrix.test.ts
npm run check:shared-test
npm run test:shared-black-box:matrix:quick
npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/tabbed-navigation.spec.ts
npm run test:e2e:rallar-black-box -- tests/playwright/rallar-black-box/tabbed-navigation.spec.ts
npm run test -- packages/tests/shared-test/rallar-provider-parity.test.ts
npm run test:e2e:rallar-black-box
RALLAR_BLACK_BOX_FULL_STACK=1 npm run test:e2e:rallar-black-box:full-stack
npm run test:e2e:rallar-black-box:full-stack:real:live-rtc-3
npm run test:e2e:rallar-black-box:full-stack:real:live-rtc-3:all
```

The full-stack suite has also been verified against a manually running `apps/api-v1` at `http://localhost:8080` with
the default static users `alice` and `bob`.
