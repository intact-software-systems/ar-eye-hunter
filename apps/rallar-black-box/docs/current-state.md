# Current State

`apps/rallar-black-box` is currently a deployable Vite/React SPA for visible black-box test operation and remote browser
agent orchestration. It is built around the shared `packages/shared-test/rallar-bb-test` facade so recipes, local UI
actions, remote control commands, runtime events, stats, and reports use one command vocabulary.

## Implemented

The implementation is complete through the first Iteration 23 full-stack harness slice and the first Manual Rallar
real-payload delivery slice in `implementation-plan.md`.

The shared facade exists in `packages/shared-test/rallar-bb-test` and defines:

- command types for `configure`, recipes, RTC, WebSocket, HTTP, health, stats, close, and reset
- runtime state, command results, events, stats snapshots, and report fragments
- redaction helpers and UI selectors
- result replay by stable command ID
- browser adapter code for fetch, WebSocket, and existing browser Rallar runtime shapes
- runner adapters, including the `rallar-remote-browser` provider
- provider-parity helpers that build portable SPA recipes, convert them to `rallar-browser` or `rallar-remote-browser`
  runner interactions, and normalize SPA/runner reports for comparison

The SPA currently provides:

- local workbench startup with a sample recipe
- URL and Vite-env bootstrap for control-agent mode
- WebSocket control client with registration, heartbeat, reconnect, command dispatch, duplicate result replay, stats, and
  final report streaming
- visible panels for configuration, recipes, command queue, active command, command history, events, stats, failures, and
  report JSON
- authenticated login gate for `browser-rallar` mode with browser-session restore and logout cleanup
- tabbed operational shell for `Manual Rallar`, `Topology`, `RTC Diagnostics`, `Local Workbench`, `Event Stream`, and
  `Rallar Server`
- persistent global header state for provider, control, runtime, room, active command, first failure, user, and session
- authenticated Rallar Server REST workbench with endpoint presets, raw request editing, auth header injection, response
  rendering, cURL export, and black-box `http.request` command export
- gated full-stack Playwright harness for API-v1, control-server, SPA, two-browser REST workbench login,
  control-orchestration smoke coverage, and a UI-driven Manual Rallar realtime payload delivery check
- manual Rallar workbench for quick configure, join, connect, send, health, close, and reset actions
- real-provider Manual Rallar `Create and join group` creates a Rallar Server group before RTC connect, so disposable
  test rooms can be created directly from the UI flow
- received-data inbox derived from runtime message events
- RTC diagnostics panel for connect phases, membership, latency, failure focus, and copyable diagnostic bundles
- topology view derived from runtime events using graphology and rendered with Sigma.js
- a Provider Parity recipe fixture for connect, direct send, multicast metadata, broadcast metadata, health, close, and
  reset checks

The minimal control server in `apps/rallar-black-box-control-server` currently provides:

- `GET /health`
- `GET /runs`
- `GET /runs/:runId`
- `POST /runs/:runId/agents/:agentId/commands`
- `POST /runs/:runId/agents/:agentId/report`
- `POST /runs/:runId/agents/:agentId/tokens`
- `GET /control` as the WebSocket upgrade endpoint for browser agents

The control server is intentionally in-memory. It is useful for local orchestration, smoke tests, and protocol
development. Durable storage and monitor-server ingestion are still planned work.

## Runtime Reality

The SPA runtime store defaults to the local/fake command executor from `src/runtime-store.ts`. That executor emits
realistic command results, diagnostics, message events, stats, and topology inputs for offline UI work. When
`provider=browser-rallar` is selected, the SPA uses `createRallarBlackBoxBrowserTestRuntime(...)` plus
`src/browser-rallar-runtime.ts` to bridge to the browser Rallar runtime.

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

The app shell is tabbed. The active tab is stored in the `tab` query parameter, and inactive tab panes remain mounted
while hidden so manual form edits, recipe JSON, selected commands, topology filters, and event filters survive normal
navigation. The `Rallar Server` tab can call API v1 REST endpoints directly from the browser. It starts from curated
OpenAPI-derived presets, can refresh endpoint rows from `/api/openapi.json`, injects the active browser auth session
when requested, redacts access tokens in visible exports, and can copy the selected request as a black-box
`http.request` command.

This means the current app is already useful for:

- validating the command contract
- validating control-server orchestration
- testing result replay and reconnect behavior
- debugging the visible UI flow
- exercising diagnostics, report, received-message, and topology surfaces
- building repeatable recipes from manual actions

It has gated real-provider smokes for one-agent connect/send and two-agent delivery. Those smokes are skipped unless a
real Rallar environment is configured. Auth, permission, stale-session, duplicate-session, and cleanup failures now emit
specific diagnostics and appear in the copyable RTC failure bundle.

Iteration 18 adds a bridge between visible SPA recipes and runner scenarios. The portable parity helper intentionally
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
- browser storage cleanup on reset

These checks are necessary because the app is a remote browser-control surface.

## Known Gaps

The main gaps are:

- the default SPA mode is still simulated for offline use
- the live `browser-rallar` connect/send, two-agent delivery smokes, and Iteration 23 Manual Rallar realtime delivery
  test are environment-gated and skipped unless real Rallar config plus local full-stack services are supplied
- real multicast/broadcast delivery and missing/stale-agent negative cases still need larger live multi-agent coverage
- the control server is in-memory and not restart-durable
- monitor-server ingestion is not connected
- long-running and seeded-random runs are still planned
- large run artifact retention and report browsing are not implemented
- auth and permission negative testing needs real backend/Rallar integration to become meaningful
- REST request collections and persisted REST recipes are not implemented yet
- topology is derived from runtime events and is not yet performance-tested for very large event streams

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
npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/tabbed-navigation.spec.ts
npm run test -- packages/tests/shared-test/rallar-provider-parity.test.ts
npm run test:e2e:rallar-black-box
RALLAR_BLACK_BOX_FULL_STACK=1 npm run test:e2e:rallar-black-box:full-stack
```

The full-stack suite has also been verified against a manually running `apps/api-v1` at `http://localhost:8080` with
the default static users `alice` and `bob`.
