# Current State

`apps/rallar-black-box` is currently a deployable Vite/React SPA for visible black-box test operation and remote browser
agent orchestration. It is built around the shared `packages/shared-test/rallar-bb-test` facade so recipes, local UI
actions, remote control commands, runtime events, stats, and reports use one command vocabulary.

## Implemented

The implementation is complete through Iteration 14 in `implementation-plan.md`.

The shared facade exists in `packages/shared-test/rallar-bb-test` and defines:

- command types for `configure`, recipes, RTC, WebSocket, HTTP, health, stats, close, and reset
- runtime state, command results, events, stats snapshots, and report fragments
- redaction helpers and UI selectors
- result replay by stable command ID
- browser adapter code for fetch, WebSocket, and existing browser Rallar runtime shapes
- runner adapters, including the `rallar-remote-browser` provider

The SPA currently provides:

- local workbench startup with a sample recipe
- URL and Vite-env bootstrap for control-agent mode
- WebSocket control client with registration, heartbeat, reconnect, command dispatch, duplicate result replay, stats, and
  final report streaming
- visible panels for configuration, recipes, command queue, active command, command history, events, stats, failures, and
  report JSON
- manual Rallar workbench for quick configure, join, connect, send, health, close, and reset actions
- received-data inbox derived from runtime message events
- RTC diagnostics panel for connect phases, membership, latency, failure focus, and copyable diagnostic bundles
- topology view derived from runtime events using graphology and rendered with Sigma.js

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

No login is required for the current local UI. The demo username, password, and token values exist only so the UI,
redaction, diagnostics, and reports can exercise credential-shaped config. They are not sent to a real Rallar service by
the current SPA executor.

Provider mode is explicit. `simulated` mode is the default. `browser-rallar` can be selected through URL or Vite env
config and requires a real Rallar API base URL plus token, username/password, or `restoreSession=true`.

This means the current app is already useful for:

- validating the command contract
- validating control-server orchestration
- testing result replay and reconnect behavior
- debugging the visible UI flow
- exercising diagnostics, report, received-message, and topology surfaces
- building repeatable recipes from manual actions

It is not yet sufficient for final validation of real deployed Rallar RTC behavior by itself. The real-provider adapter
is wired, but the next implementation step is an environment-gated connect/send smoke against a configured Rallar
environment, followed by two-agent delivery validation.

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
- `browser-rallar` is wired, but real connect/send has not yet been smoke-tested against a configured Rallar environment
- the control server is in-memory and not restart-durable
- monitor-server ingestion is not connected
- long-running and seeded-random runs are still planned
- large run artifact retention and report browsing are not implemented
- auth and permission negative testing needs real backend/Rallar integration to become meaningful
- topology is derived from runtime events and is not yet performance-tested for very large event streams

## Verification Commands

Focused checks used for the current state:

```sh
npm --workspace rallar-black-box run build
npm run test -- packages/tests/rallar-black-box/topology-graph.test.ts packages/tests/rallar-black-box/rtc-diagnostics.test.ts packages/tests/rallar-black-box/manual-workbench.test.ts packages/tests/rallar-black-box/control-bootstrap.test.ts packages/tests/rallar-black-box/control-client.test.ts
npm run test:e2e:rallar-black-box
```
