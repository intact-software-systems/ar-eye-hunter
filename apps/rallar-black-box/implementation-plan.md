# Black-box Rallar Implementation Plan

## Goal

`apps/rallar-black-box` should become a deployable, remote-controlled browser SPA for black-box Rallar RTC, WebSocket,
and HTTP testing.

The app should let a browser register with a control server, receive test recipes and commands over WebSocket, execute
those commands through Rallar or browser-native HTTP/WebSocket APIs, and stream events, diagnostics, stats, and reports
back to the server.

The first production shape is still headless-first. A visible UI is also a first-class requirement: visible runs should
show the loaded configuration, active recipe, executing command, completed commands, results, diagnostics, messages,
stats, and failures. The same runtime must work when the black-box runner starts a headless browser and points it at
this app.

## Boundary

The existing `packages/shared-test/black-box-runner/browser` harness is not the production app. It is a minimal
Playwright harness for local test execution.

`apps/rallar-black-box` should be the deployable browser agent:

```text
black-box runner or control service
    -> WebSocket or REST control plane
        -> apps/rallar-black-box
            -> shared-test black-box Rallar facade
                -> browser Rallar facade
                    -> deployed Rallar REST API, signaling, and RTC data paths
```

The app should not reimplement WebRTC, signaling, room membership, or Rallar routing. It should delegate that work to
the existing browser Rallar facade.

## Current Foundation

The repo already has a useful browser-backed RTC foundation:

- `packages/shared-test/black-box-runner` has a provider-neutral RTC runner contract for `rtc.connect`, `rtc.send`,
  `rtc.wait`, and `rtc.close`.
- `rallar-browser` is the current opt-in real browser RTC provider. It uses Playwright, a small browser harness, and the
  existing browser `rallar` facade.
- `packages/shared-test/black-box-runner/browser/rallar-browser-runtime.ts` already exposes the important browser
  runtime shape: `connect`, `send`, `close`, and `health`.
- `packages/shared-web/browser/rallar.ts` already owns the browser Rallar facade for auth, connect, rooms,
  `rallar.realtime`, `rallar.messages.rtc`, `rallar.messages.ws`, and health.
- The default runner provider named `rallar` is still WebSocket signaling-only. Real browser RTC behavior should
  continue to use `rallar-browser` or the shared facade created from that work.

The SPA plan should build on this foundation. It should not create a second black-box runtime with different command
semantics.

## Current Execution Reality After Iteration 15C

The visible SPA defaults to the local/fake executor in `apps/rallar-black-box/src/runtime-store.ts`. The UI,
command/result contract, control WebSocket, diagnostics, reports, received-data inbox, and topology are real, and the
default simulated provider remains useful for offline UI and protocol development.

Real Rallar execution is now an explicit opt-in provider mode. When `provider=browser-rallar` is selected with a real
API base URL and supported auth config, the SPA uses the shared browser adapter, lazy-loads the browser Rallar runtime,
and calls the browser facade for auth, connect, room join, subscriptions, RTC send, browser WebSocket, browser HTTP,
health, close, and reset behavior.

The current live proof is a gated smoke set: one-agent connect/send plus two-agent realtime and `messages.rtc` delivery
where one browser receives payloads sent by another browser.

Target provider modes:

```text
simulated       -> current fake executor for offline UI and protocol development
browser-rallar  -> real browser Rallar facade for auth, signaling, RTC, WebSocket, and HTTP behavior
```

The UI must always show which executor/provider is active so a user cannot mistake simulated loopback events for real
Rallar RTC delivery.

## App Shape

Use React plus Vite, consistent with the other app packages.

The app should include:

- headless-safe startup with configuration from URL, environment, or bootstrap endpoint
- a WebSocket control client
- a command dispatcher for RTC, WebSocket, and HTTP test actions
- a compact but complete operational UI for local and visible runs
- event, diagnostic, stats, and report streaming
- strict schema validation at the control boundary
- redaction of credentials and sensitive payload fields

The UI should be operational rather than a landing page. It should show connection state, active run, agent identity,
current actor/session, loaded config, recipe steps, command queue, executing command, completed command results, recent
messages, health stats, diagnostics, and failures.

## Shared-test Facade

`rallar-bb-test` is the core next implementation step. The SPA, the local Playwright provider, and any future remote
runner provider should all speak the same command/result/event contract.

Recommended working name:

```text
rallar-bb-test
```

Use the short name for the package/folder and use explicit exported TypeScript names:

```ts
RallarBlackBoxTestRuntime
RallarBlackBoxTestCommand
RallarBlackBoxTestResult
RallarBlackBoxTestEvent
createRallarBlackBoxTestRuntime(...)
```

This keeps the module name concise while avoiding opaque `BB` naming in public type names.

Initial location:

```text
packages/shared-test/rallar-bb-test
```

The facade should own the black-box test contract, not the browser app and not the runner:

- command and event types
- command dispatcher
- runtime state machine
- stats snapshot model
- report fragment model
- redaction helpers
- adapters to the existing browser Rallar facade
- adapters to existing black-box runner RTC events where useful
- recipe normalization and validation helpers
- result replay/cache helpers keyed by stable command IDs
- UI-friendly selectors for current config, active command, command history, messages, diagnostics, stats, and failures

The current `rallar-browser-runtime.ts` should inform the facade and then become a thin Playwright/harness adapter over
it. The new facade should avoid depending on Playwright globals such as `window.__blackBoxRallar`.

## UI Operating Model

The SPA should be usable in visible mode without reading logs or DevTools.

Initial UI areas:

| Area                 | Purpose                                                                                                                                       |
|----------------------|-----------------------------------------------------------------------------------------------------------------------------------------------|
| Run header           | Agent ID, run ID, protocol version, control connection state, Rallar connection state, selected environment, and current actor/session.       |
| Configuration view   | Effective bootstrap config, effective Rallar config, selected transport, room, actor, redacted credentials, and source of each config value.  |
| Recipe/command queue | Ordered or grouped recipe steps, command IDs, status, deadlines, retries, and the command currently executing.                                |
| Results view         | Per-command result, duration, ok/error state, response summary, selected payload data, and links to related events.                           |
| Event stream         | Messages, diagnostics, close events, health changes, and report fragments with filters by kind, command ID, connection, actor, and transport. |
| Stats view           | Current counters, recent errors, peer count, RTC lane health, reconnect count, latency summary, and last event timestamp.                     |
| Failure focus        | First failure, active error, retry state, timeout diagnostics, and redacted details needed to debug the run.                                  |

The UI should read from the `rallar-bb-test` runtime state and event stream. It should not maintain a separate
interpretation of command semantics.

## Implementation Principles

- Build the shared contract first. The SPA should not define command semantics that later need to be copied back into
  the runner.
- Keep one actor/session per browser page for the first implementation. Multi-actor orchestration should happen through
  multiple agents/pages unless a later use case proves otherwise.
- Keep local and remote behavior comparable. A recipe that passes through the local `rallar-browser` provider should
  have an equivalent remote-agent path with comparable reports.
- Make UI state derive from runtime events, command state, and stats snapshots. Avoid UI-only state that changes the
  meaning of a run.
- Treat browser-native HTTP and WebSocket commands as privileged remote-control actions. They need schema validation,
  destination allowlists, size limits, and redaction before broad deployment.

## Recipe Scope

The app should execute recipes sent from the server. A recipe is an ordered or partially parallel plan of commands with
expectations, timeouts, and reporting rules.

Initial recipe families:

| Family    | Purpose                                                                                                    |
|-----------|------------------------------------------------------------------------------------------------------------|
| RTC       | Exercise `rallar.realtime`, `rallar.messages.rtc`, room membership, peer links, and RTC payload delivery.  |
| WebSocket | Exercise raw WebSocket endpoints, Rallar WebSocket topics, reconnect behavior, and server push paths.      |
| HTTP      | Exercise REST endpoints, auth flows, bootstrap/config endpoints, report uploads, and API failure behavior. |

The recipe model should keep transport-specific details in command payloads while using a shared envelope for command
IDs, timing, status, diagnostics, stats, and report fragments.

## Control Protocol

Use WebSocket as the primary control channel. The browser initiates the socket connection, then the server pushes
commands over that open connection.

REST can still be useful for:

- bootstrap configuration
- uploading larger final reports or artifacts
- fetching command batches when WebSocket reconnects
- retrieving historical run state

Suggested command envelope:

```ts
type ControlCommandEnvelope = {
    kind: 'command'
    protocolVersion: 1
    runId: string
    agentId: string
    commandId: string
    command: RallarBlackBoxTestCommand
    deadlineEpochMs?: number
}
```

Suggested response envelope:

```ts
type ControlResultEnvelope = {
    kind: 'result'
    protocolVersion: 1
    runId: string
    agentId: string
    commandId: string
    ok: boolean
    result?: RallarBlackBoxTestResult
    error?: {
        code: string
        message: string
        details?: unknown
    }
}
```

Suggested event envelope:

```ts
type ControlEventEnvelope = {
    kind: 'event' | 'diagnostic' | 'stats' | 'report'
    protocolVersion: 1
    runId: string
    agentId: string
    atEpochMs: number
    payload: unknown
}
```

The protocol should require stable command IDs. Results should be replay-safe so reconnects do not duplicate
irreversible work.

## Command Set

Initial commands:

| Command         | Purpose                                                                                        |
|-----------------|------------------------------------------------------------------------------------------------|
| `configure`     | Set API base URL, actor identity, transport, room, and test defaults.                          |
| `recipe.load`   | Load and validate a recipe without executing it.                                               |
| `recipe.run`    | Execute a loaded recipe or an inline recipe.                                                   |
| `recipe.cancel` | Cancel a running recipe and report the last known command state.                               |
| `rtc.connect`   | Authenticate, connect Rallar, join room, and start selected RTC listeners.                     |
| `rtc.send`      | Send over `rallar.realtime` or `rallar.messages.rtc`.                                          |
| `ws.open`       | Open a raw or Rallar WebSocket connection.                                                     |
| `ws.send`       | Send a WebSocket message.                                                                      |
| `ws.close`      | Close a WebSocket connection and report close diagnostics.                                     |
| `http.request`  | Execute a browser HTTP request and report status, headers, timing, and selected response data. |
| `health`        | Return Rallar status, RTC lane health, counters, and current session metadata.                 |
| `stats`         | Return a stats snapshot without changing connection state.                                     |
| `close`         | Close listeners and disconnect/log out according to config.                                    |
| `reset`         | Clear runtime state after a run or failed setup.                                               |

`rallar.realtime` versus `rallar.messages.rtc` should be a configuration option on `configure`, `connect`, or the
individual `send` command.

## Stats And Reports

Support both periodic stats and final reports.

Recommended first implementation:

- send lightweight stats over WebSocket every N seconds while connected
- send command results and important diagnostics immediately over WebSocket
- optionally upload larger final reports over REST when a run completes

Stats should include:

- WebSocket connection state
- Rallar auth/connect status
- room ID, actor, session ID, and selected transport
- sent and received message counters
- observed peer count
- RTC lane health where available
- recent error count
- reconnect count
- command latency summary
- last command ID and last event timestamp

Reports should reuse the black-box runner report vocabulary where possible so local headless runs and remote SPA runs
can be compared. The facade should provide a normalized report model first, then adapters can emit the existing runner
report shape and any monitor-server ingestion shape.

## Graph Visualisation

Graph visualisation should be a later iteration.

Use `graphology` for the graph data model. Use Sigma.js for browser rendering when we need an interactive graph view;
Sigma.js is built around rendering graphology graphs in the browser.

Useful graph views:

- agent topology by `agentId`
- Rallar sessions by session ID
- rooms and membership
- observed RTC peer links
- message routes for `messages.rtc`
- failed or degraded links highlighted by recent diagnostics

The graph should be derived from events and stats. It should not become a required dependency for headless execution.

## Proposed Iterations

Each iteration keeps a short result log so the plan remains useful after work is
performed.

### Iteration 1: Planning Document

Create this implementation plan and agree on app, facade, and protocol boundaries.

Status: completed.

Results:

- Initial app, facade, protocol, UI, and security boundaries are documented in this plan.
- The plan now treats the visible UI as a first-class operational surface while preserving the headless-first runtime
  requirement.

### Iteration 2: `rallar-bb-test` Facade Skeleton

Create `packages/shared-test/rallar-bb-test` with command, result, event, stats, and report types.

Status: completed.

Results:

- Added `packages/shared-test/rallar-bb-test` with command, result, event, stats, report, state, runtime, and selector
  types.
- Added the in-memory/fake runtime for UI and protocol testing.
- Added redaction helpers and runtime-level redaction for config, diagnostics, command payloads, results, and events.
- Added recipe load/run/cancel command types and fake runtime execution.
- Added stable command ID result replay through `resultCache`.
- Added UI selectors for current config, active command, history, events, diagnostics, messages, stats, and failures.
- Added `packages/tests/shared-test/rallar-bb-test.test.ts` covering redaction, runtime configuration, recipe execution,
  invalid recipe failures, replay behavior, and JSON serialization.
- Verified with `npx vitest run packages/tests/shared-test/rallar-bb-test.test.ts`.
- Verified with `npm --workspace @ar-eye-hunter/shared-test run typecheck`.

Deliverables:

- typed command contract
- runtime interface
- no-op or fake runtime for UI and protocol testing
- redaction helpers
- tests for command/result serialization
- recipe load/run/cancel types
- state selectors for UI views
- command ID and result replay rules documented in code comments/tests

This is the core next step. Do this before building real SPA behavior so the app, runner, and remote-control provider do
not drift.

### Iteration 3: Browser Runtime Adapters And Runner Parity

Move reusable browser runtime behavior behind the new facade.

Status: completed.

Results:

- Extended the `rallar-bb-test` runtime with an optional command executor and public event recording hook so adapters
  can execute real browser operations while preserving the same state, result, replay, redaction, and selector behavior.
- Added `packages/shared-test/rallar-bb-test/browser-adapter.ts`.
- Added a browser runtime adapter for `rtc.connect`, `rtc.send`, `ws.open`, `ws.send`, `ws.close`, `http.request`,
  `health`, `close`, and `reset`.
- Added delegation from facade RTC commands to the existing browser Rallar runtime shape exposed by
  `black-box-runner/browser/rallar-browser-runtime.ts`.
- Added browser-native `fetch` support for `http.request`, including relative-path resolution from configured
  `apiBaseUrl`, response headers/body capture, and runtime redaction.
- Added browser-native `WebSocket` support for open/send/close plus message, close, and error event bridging into facade
  events.
- Added `receiveRallarBrowserEvent(...)` so events emitted by the existing browser harness can be normalized into facade
  diagnostics/messages/events.
- Added `packages/shared-test/rallar-bb-test/black-box-runner-adapter.ts` so the existing black-box runner RTC provider
  contract can drive a `RallarBlackBoxTestRuntime`.
- Added tests covering RTC adapter delegation, HTTP command execution, WebSocket command execution, browser Rallar event
  bridging, and black-box runner RTC scenario execution through the facade adapter.
- Verified with `npx vitest run packages/tests/shared-test/rallar-bb-test.test.ts`.
- Verified with `npm --workspace @ar-eye-hunter/shared-test run typecheck`.
- Ran `npx vitest run packages/tests/shared-test`; the new tests passed, while two existing Deno-import suites still
  fail in Node/Vitest with `https:` ESM loader errors.

Deliverables:

- adapter from `RallarBlackBoxTestCommand` to browser Rallar facade calls
- adapter from facade commands to browser-native `fetch`
- adapter from facade commands to browser-native `WebSocket`
- support for `configure`, `rtc.connect`, `rtc.send`, `ws.open`, `ws.send`, `ws.close`, `http.request`, `health`,
  `stats`, `close`, and `reset`
- transport option for `realtime` and `messages.rtc`
- event bridge from Rallar callbacks, WebSocket callbacks, and HTTP results to facade events
- adapter from the existing `rallar-browser` provider/harness to the new facade
- parity tests showing existing `rallar-browser` RTC scenarios still produce comparable reports

### Iteration 4: React App Scaffold And Runtime Store

Create `apps/rallar-black-box` as a Vite React app with package scripts, TypeScript config, Vite aliases, and a UI store
backed by the fake `rallar-bb-test` runtime.

Status: completed.

Results:

- Added `apps/rallar-black-box` as a Vite React workspace app with package scripts, TypeScript config, Vite aliases, and
  React entrypoint.
- Added root convenience scripts `dev:rallar-black-box` and `build:rallar-black-box`.
- Added a runtime store in `src/runtime-store.ts` backed by the fake `rallar-bb-test` runtime and subscribed through
  `useSyncExternalStore`.
- Added a local scaffold recipe that exercises the shared facade command model for `configure`, `recipe.load`,
  `recipe.run`, `rtc.connect`, `rtc.send`, `ws.open`, `http.request`, and `stats` without opening real network sockets.
- Added an operational app shell showing run header, agent/run/control/Rallar status, redacted configuration, command
  queue status, selected command result, event stream filtering, stats, and first-failure focus.
- Kept the app free of WebSocket control-client dependencies; WebSocket activity is simulated through the fake runtime
  for visible scaffold state only.
- Added `/apps/rallar-black-box/dist/` to `.gitignore`.
- Verified with `npm --workspace rallar-black-box run typecheck`.
- Verified with `npm --workspace rallar-black-box run build`.

Deliverables:

- app shell
- build and typecheck scripts
- runtime state store subscribed to facade events
- run header with agent/run/control/Rallar status
- configuration panel with redacted effective config
- command queue panel with pending/running/completed status
- result detail panel for the selected command
- event stream panel with filtering by event kind
- no WebSocket dependency yet

### Iteration 5: Local Recipe Workbench

Let the React app execute commands locally from a development panel, pasted JSON, or fixture file.

Status: completed.

Results:

- Added local recipe fixtures for RTC smoke, WebSocket plus HTTP smoke, expected failure, and cancellable long-running
  runs.
- Added a local workbench panel that lets a visible user select a fixture, edit or paste recipe JSON, load the recipe,
  run it, cancel it, reset state, and execute a single manual command JSON payload.
- Added store actions for local recipe load, recipe run, recipe cancel, reset, and manual command execution without a
  server.
- Added visible run-state tracking for waiting, running, passed, failed, cancelled, and reset.
- Added invalid JSON and invalid recipe handling that surfaces errors in the UI and in runtime failure state.
- Extended fake local execution for `ws.send` and `ws.close` in addition to RTC, WebSocket open, HTTP, stats, and reset
  paths.
- Added fixture coverage for local RTC, WebSocket, and HTTP recipe examples.
- Kept network activity simulated in the local workbench so the app remains usable before the WebSocket control client
  iteration.
- Verified with `npm --workspace rallar-black-box run typecheck`.
- Verified with `npm --workspace rallar-black-box run build`.
- Verified the running dev server with `curl -I http://localhost:5176/`.

Deliverables:

- manual command execution without a server
- local recipe load, validate, run, cancel, reset
- visible results and diagnostics
- test fixtures for common command sequences
- parity check against the existing Playwright harness behavior
- local RTC, WebSocket, and HTTP recipe examples
- UI states for invalid config, waiting, running, passed, failed, cancelled, and reset

### Iteration 6: Execution Visibility UI

Make visible runs useful for debugging actual failures.

Status: completed.

Results:

- Added active-command start timing to `RallarBlackBoxTestState` so the UI can show elapsed time and derived deadlines
  while a command is executing.
- Added command latency, reconnect count, peer count, and RTC lane-health fields to runtime stats snapshots.
- Added a current-focus panel showing active command ID, kind, request/result JSON, elapsed time, deadline, remaining
  time, retry metadata, and selected result details.
- Added a completed-command history panel with status, duration, result summary, and selectable command rows.
- Expanded event filtering from kind-only to kind, command ID, connection, actor, transport, topic text, and severity.
- Added richer stats display for counters, reconnects, peer count, RTC lane health, and command latency summary.
- Added a first-failure focus panel with redacted failure details.
- Added an exportable redacted report snapshot view containing run/config summary, stats, command results, and events.
- Verified with `npm --workspace rallar-black-box run typecheck`.
- Verified with `npm --workspace rallar-black-box run build`.
- Verified the shared facade changes with `npm --workspace @ar-eye-hunter/shared-test run typecheck`.
- Verified focused facade tests with `npx vitest run packages/tests/shared-test/rallar-bb-test.test.ts`.
- Verified the running dev server with `curl -I http://localhost:5176/`.

Deliverables:

- current command focus with request, deadline, elapsed time, and retry state
- completed-command history with status, duration, result summary, and error details
- event-to-command correlation by `commandId`
- message/diagnostic filters by connection, actor, transport, topic, and severity
- stats snapshot panel with counters, peer count, RTC lane health, reconnect count, and latency summary
- first-failure panel with redacted diagnostic details
- exportable redacted report snapshot from the UI

### Iteration 7: WebSocket Control Client

Add the remote control WebSocket client to the SPA.

Status: completed.

Results:

- Added `src/control-protocol.ts` with protocol version constants, typed register/heartbeat/result/event/command
  envelopes, inbound command parsing, run/agent matching, command-kind validation, and runtime-event-to-control-envelope
  mapping.
- Added `src/control-client.ts` with an injectable WebSocket factory so the browser app can use the real `WebSocket`
  while tests and future harnesses can use a mock socket.
- Implemented agent registration, immediate heartbeat, periodic heartbeat, socket error diagnostics, exponential
  reconnect, and manual disconnect handling.
- Implemented command dispatch through the shared `rallar-bb-test` runtime using stable server-provided command IDs.
- Implemented replay-safe command handling: duplicate command IDs return the cached result without re-executing, and
  reconnect registration advertises completed command IDs before replaying completed results.
- Implemented runtime event streaming for diagnostics, messages, stats, reports, result events, and other runtime events
  over the control channel.
- Added command-correlated control diagnostics so visible UI filters and server-side telemetry can tie command receipt
  and failures back to `commandId`.
- Added a Control Client panel to the app UI with WebSocket URL, run ID, agent ID, connect/disconnect controls,
  sent/received counts, reconnect count, heartbeat timestamp, and last socket/protocol error.
- Added store actions for connecting and disconnecting the control client while preserving the local workbench path.
- Added `packages/tests/rallar-black-box/control-client.test.ts` covering protocol validation, registration, command
  dispatch, event streaming, duplicate result replay, and reconnect resume replay.
- Verified with `npx vitest run packages/tests/rallar-black-box/control-client.test.ts`.
- Verified with `npx vitest run packages/tests/shared-test/rallar-bb-test.test.ts`.
- Verified with `npm --workspace rallar-black-box run typecheck`.
- Verified with `npm --workspace rallar-black-box run build`.
- Verified the running dev server with `curl -I http://localhost:5176/`.

Deliverables:

- agent registration
- heartbeat and reconnect
- command dispatch by command ID
- result and event streaming
- protocol version checks
- client-side schema validation at the control envelope and command-kind boundary
- reconnect resume using stable run ID, agent ID, and command IDs
- replay of already completed command results after reconnect

### Iteration 8A: Minimal In-memory Control Server

Add a small server-side control plane for test orchestration so the browser SPA has a real WebSocket peer before durable
monitor integration exists.

This should live outside `apps/rallar-monitor-server` for now. The monitor server plan keeps its first responsibility as
observability and analysis, not orchestration. The minimal control server can later forward accepted results/events into
the monitor ingestion API.

Status: completed.

Results:

- Added `apps/rallar-black-box-control-server` as a small Deno app for local black-box control orchestration.
- Added a WebSocket agent endpoint at `/control`, matching the SPA default `ws://localhost:5180/control`.
- Added an in-memory control service for runs, agents, queued commands, dispatched commands, results, heartbeats, and
  event telemetry.
- Added stable command dispatch by `runId`, `agentId`, and `commandId`.
- Added reconnect-aware dispatch: commands already dispatched on a previous connection are resent on reconnect unless
  the agent advertises the command ID in its resume-completed set.
- Added result ingestion that marks queued commands completed and clears resume suppression once the replayed result
  arrives.
- Added REST command enqueueing with `POST /runs/:runId/agents/:agentId/commands`.
- Added REST state inspection with `GET /runs` and `GET /runs/:runId`.
- Added `GET`/`HEAD /health` for local readiness checks.
- Added root convenience scripts `dev:rallar-black-box-control`, `check:rallar-black-box-control`, and
  `test:rallar-black-box-control`.
- Added `parseControlClientMessage(...)` to the shared control protocol so server-side ingestion validates browser
  client envelopes before storing them.
- Added Deno tests covering registration, command queuing, dispatch suppression on completed resume IDs, result
  ingestion, heartbeat/event storage, and client-envelope parsing.
- Verified with `deno fmt --check` in `apps/rallar-black-box-control-server`.
- Verified with `deno task check` in `apps/rallar-black-box-control-server`.
- Verified with `deno task test` in `apps/rallar-black-box-control-server`.
- Verified the browser app protocol changes with `npm --workspace rallar-black-box run typecheck`.
- Verified the browser app build with `npm --workspace rallar-black-box run build`.
- Verified focused Vitest suites with
  `npx vitest run packages/tests/shared-test/rallar-bb-test.test.ts packages/tests/rallar-black-box/control-client.test.ts`.
- Verified the running control server with `curl -I http://localhost:5180/health` and `curl http://localhost:5180/runs`.

Deliverables:

- Deno app for a local black-box control server
- WebSocket endpoint for browser agents at the same default URL used by the SPA
- in-memory run and agent registry
- in-memory command queue
- command dispatch to connected agents
- result, heartbeat, and event ingestion from connected agents
- reconnect handling using stable run ID, agent ID, and command IDs
- REST endpoint to enqueue commands for an agent
- REST endpoints to inspect in-memory run state
- focused tests for registration, queuing, dispatch, result ingestion, and reconnect resume behavior

### Iteration 8B: Headless Control Bootstrap And Smoke

Make the SPA behave like a real headless browser agent without a human clicking Connect.

Status: completed.

Results:

- Added URL and Vite-env bootstrap parsing for control-agent mode.
- Added URL parameters for `mode=control`, `controlUrl`, `autoConnect`, `runId`, `agentId`, `environment`, `apiBaseUrl`,
  `actor`, `sessionId`, `roomId`, and `transport`.
- Added Vite environment fallbacks for control URL, auto-connect, run ID, agent ID, environment, API base URL, actor,
  session, room, and transport.
- Changed startup so local workbench mode still runs the visible demo recipe, while control-agent mode configures the
  shared runtime and waits for server commands.
- Added auto-connect startup when `mode=control` or `autoConnect=1` is present.
- Added a Bootstrap panel showing bootstrap source, mode, auto-connect state, control URL, run ID, and agent ID.
- Added focused Vitest coverage for bootstrap config resolution.
- Added a Playwright smoke config for `apps/rallar-black-box`.
- Added an end-to-end smoke test that opens the SPA with control-agent URL params, waits for WebSocket registration,
  enqueues a command through the control server REST API, and verifies the result is collected by the control server and
  visible in the SPA.
- Added root convenience script `test:e2e:rallar-black-box`.
- Ignored the app-local Playwright `test-results` and `playwright-report` output directories.
- Verified with `npm --workspace rallar-black-box run typecheck`.
- Verified with `npm --workspace rallar-black-box run build`.
- Verified with
  `npx vitest run packages/tests/rallar-black-box/control-bootstrap.test.ts packages/tests/rallar-black-box/control-client.test.ts`.
- Verified with `npm run test:e2e:rallar-black-box`.

Deliverables:

- headless-safe URL/env control bootstrap
- automatic control WebSocket connection on startup
- local-workbench startup preserved for visible development
- visible bootstrap/control status
- end-to-end browser-agent smoke test against the minimal control server

### Iteration 8C: Durable Control And Monitor Integration

Connect the control-plane output to a durable backend once the minimal end-to-end protocol is proven.

Status: planned.

Results:

- Not started.

Open decision:

- add deployed control endpoints to `apps/api-v1` only if they belong to production Rallar infrastructure
- keep the black-box control server if orchestration should remain test-owned
- send collected runs to `apps/rallar-monitor-server` if they should become monitor data
- support multiple servers later with the same protocol

Deliverables:

- durable or replayable command/result store
- authentication and token issuance
- monitor-server ingestion for accepted results, events, stats, and reports
- control-server restart recovery strategy
- retention rules for command/result/event state
- deployment decision for production, test orchestration, and monitor-server boundaries

### Iteration 9A: Black-box Runner Remote RTC Provider

Teach black-box-runner RTC scenarios to target a remote SPA agent in addition to the local Playwright harness.

Status: completed.

Results:

- Added `packages/shared-test/black-box-runner/rallar-remote-browser-provider.ts`.
- Registered the default RTC provider name `rallar-remote-browser`.
- Added remote RTC `connect`, `send`, `wait`, and `close` support through the minimal control server REST API.
- Mapped runner RTC connect actions to `rallar-bb-test` `rtc.connect` commands.
- Mapped runner RTC send actions to `rallar-bb-test` `rtc.send` commands.
- Mapped runner RTC close and auto-close cleanup to `rallar-bb-test` `close` commands.
- Added control-server polling for command results through `GET /runs/:runId`.
- Added remote event synchronization so streamed SPA message events populate the runner's existing `rtcMessages` report and expectation machinery.
- Preserved existing runner timeout diagnostics by returning RTC failure statuses when the control server rejects commands or does not return a result in time.
- Added configuration through request fields, runner options, provider options, or environment variables for control base URL, run ID, agent ID, poll interval, and timeout.
- Added focused tests for provider registration, connect/send/close command mapping, remote message expectations, timeout failures, and auto-close cleanup.
- Verified with `npm --workspace @ar-eye-hunter/shared-test run typecheck`.
- Verified with `npx vitest run packages/tests/shared-test/rallar-remote-browser-provider.test.ts`.

Provider name:

```text
rallar-remote-browser
```

Deliverables:

- runner provider that sends facade commands over the control server
- mapping from black-box runner RTC actions to remote commands
- reuse of existing report collection where possible
- timeout and disconnect diagnostics
- focused tests proving remote RTC command dispatch and report collection use the existing runner report shape

### Iteration 9B: Remote Runner WebSocket And HTTP Actions

Teach black-box-runner WebSocket and HTTP interactions to execute through the remote SPA agent when requested.

Status: completed.

Results:

- Exported the remote browser control helpers from `packages/shared-test/black-box-runner/rallar-remote-browser-provider.ts` so non-RTC runner actions can reuse the same command enqueueing, result polling, and event synchronization path added in Iteration 9A.
- Added remote HTTP execution for black-box runner HTTP interactions marked with `provider: rallar-remote-browser`, `remoteProvider: rallar-remote-browser`, `remoteBrowser: true`, or equivalent `control` fields.
- Mapped runner HTTP requests to `rallar-bb-test` `http.request` commands, including URL/path, method, headers, body/form data, credentials, mode, timeout, and response body mode.
- Reused the existing runner HTTP response comparison path for remote HTTP results so status-code checks, JSON body comparisons, and failure report fields match local fetch execution.
- Added remote WebSocket execution for `connect`, `send`, `wait`/`expect`, and `close` actions when the request is marked for the remote browser or when the connection was opened remotely.
- Mapped runner WebSocket `connect`, `send`, and `close` actions to `rallar-bb-test` `ws.open`, `ws.send`, and `ws.close` commands.
- Extended remote event synchronization so SPA WebSocket message events populate the runner's existing `wsMessages` buffer and WebSocket close events populate `wsCloseEvents`.
- Added destination allowlist support for remote HTTP and WebSocket URLs through request/control/options `allowedHosts` and `allowedOrigins`.
- Added remote payload-size limits through request/control/options `maxPayloadBytes` or `maxRemotePayloadBytes`, with a default 1 MB cap.
- Added focused tests for remote HTTP command routing, remote WebSocket open/send/close routing, WebSocket message replay, HTTP destination blocking, and WebSocket payload-size blocking.
- Verified with `npm --workspace @ar-eye-hunter/shared-test run typecheck`.
- Verified with `npm run test -- packages/tests/shared-test/rallar-remote-browser-provider.test.ts`.

Deliverables:

- remote execution mode for black-box runner HTTP actions
- remote execution mode for black-box runner WebSocket actions
- mapping from runner HTTP actions to `rallar-bb-test` `http.request` commands
- mapping from runner WebSocket open/send/close actions to `rallar-bb-test` `ws.open`, `ws.send`, and `ws.close` commands
- report parity between local runner HTTP/WebSocket execution and remote browser-agent execution
- destination allowlist and payload-size checks before broad use

### Iteration 10: Periodic Stats And Report Uploads

Add periodic stats and final report streaming.

Status: completed.

Results:

- Added configurable periodic stats streaming to `apps/rallar-black-box/src/control-client.ts`.
- The browser control agent now sends an initial stats envelope after registration and then sends periodic WebSocket `stats` envelopes while connected.
- Added `statsIntervalMs` bootstrap configuration through URL query parameters and `VITE_RALLAR_STATS_INTERVAL_MS`.
- Added final report generation from the browser agent's runtime state, including summary, command results, events, and latest stats.
- Final reports are sent over the existing control WebSocket as `report` envelopes when the runtime reaches a terminal state and during manual disconnect cleanup.
- Added optional REST final-report upload through `finalReportUploadUrl`, URL query parameter `reportUploadUrl`, or `VITE_RALLAR_REPORT_UPLOAD_URL`.
- Added `POST /runs/:runId/agents/:agentId/report` to the control server for REST report ingestion.
- Added server-side in-memory `stats` and `reports` storage alongside the existing events stream in run snapshots.
- Applied black-box redaction to report payloads before client upload and again before server report storage.
- Added focused control-client tests for periodic WebSocket stats events and redacted final report upload.
- Added control-service tests for separate stats/report storage and report redaction.
- Verified with `npm --workspace rallar-black-box run typecheck`.
- Verified with `npm run test -- packages/tests/rallar-black-box/control-client.test.ts`.
- Verified with `npm run check:rallar-black-box-control`.
- Verified with `npm run test:rallar-black-box-control`.

Deliverables:

- stats interval config
- WebSocket stats events
- REST final-report upload option
- report redaction
- server-side storage or file output for collected reports

### Iteration 11: Security And Operational Hardening

Harden the remote-control surface before any broad deployment.

Status: completed.

Results:

- Added strict control-command validation in `apps/rallar-black-box/src/control-protocol.ts`, including per-kind field validation for configure, recipe, RTC, WebSocket, HTTP, health, stats, close, and reset commands.
- The control server now validates REST-enqueued commands before storing or dispatching them.
- Added server-side command allowlists through `RALLAR_BLACK_BOX_ALLOWED_COMMANDS`.
- Added command idempotency rules: repeated enqueue of the same command ID with the same payload returns the existing command, while a different payload is rejected.
- Added server-side command enqueue rate limiting through `RALLAR_BLACK_BOX_COMMAND_RATE_LIMIT_MAX` and `RALLAR_BLACK_BOX_COMMAND_RATE_LIMIT_WINDOW_MS`.
- Added request payload-size limits through `RALLAR_BLACK_BOX_MAX_REQUEST_BYTES`.
- Added optional short-lived run tokens with `POST /runs/:runId/agents/:agentId/tokens`, token expiry, WebSocket register validation, and REST command/report validation.
- Added run-token propagation from the visible browser agent and remote browser runner provider through bearer authorization headers.
- Added origin and TLS enforcement hooks through `RALLAR_BLACK_BOX_ALLOWED_ORIGINS` and `RALLAR_BLACK_BOX_REQUIRE_TLS`.
- Added server-side HTTP/WebSocket destination allowlists for browser-native commands through HTTP/WS allowed host and origin environment variables.
- Added best-effort browser `localStorage` and `sessionStorage` cleanup before executing remote `reset` commands.
- Preserved existing result replay after reconnect and covered the adjacent idempotency behavior with tests.
- Added focused tests for command allowlists, idempotency, rate limits, run token expiry, report auth headers, and browser storage cleanup.
- Verified with `npm --workspace rallar-black-box run typecheck`.
- Verified with `npm --workspace @ar-eye-hunter/shared-test run typecheck`.
- Verified with `npm run check:rallar-black-box-control`.
- Verified with `npm run test:rallar-black-box-control`.
- Verified with `npm run test -- packages/tests/rallar-black-box/control-client.test.ts`.
- Verified with `npm run test -- packages/tests/shared-test/rallar-remote-browser-provider.test.ts`.

Deliverables:

- short-lived run tokens
- strict command schema validation
- command allowlist
- origin and TLS requirements
- sensitive field redaction
- result replay after reconnect
- command idempotency rules
- rate limits and payload size limits
- HTTP and WebSocket destination allowlists for browser-native commands
- clear browser storage cleanup rules between runs

### Iteration 12: Manual Rallar Test Workbench

Add a UI path for quick Rallar testing without authoring or loading a full recipe.

Status: completed.

Results:

- Added `apps/rallar-black-box/src/manual-workbench.ts` with testable manual command builders, payload JSON parsing, received-message derivation, payload presets, and recipe-snippet generation.
- Added a structured Manual Rallar panel to the SPA that emits normal `rallar-bb-test` commands for configure, create/join group, connect, send, health, close, and reset actions.
- Added environment, API base URL, actor, session, group, connection, target client, multicast clients, transport, timeout, WebSocket URL, topic, type ID, and topic ID controls.
- Added JSON payload presets, live payload validation, and generated command preview for direct, multicast, and broadcast payload sends.
- Added RTC realtime, RTC `messages.rtc`, and WebSocket send command generation, including direct target, multicast target, and broadcast metadata.
- Added manual action history with command links back into the existing result, diagnostic, stats, and event inspection surfaces.
- Added copyable recipe-snippet generation from manual actions so useful manual checks can become repeatable recipes.
- Added a dedicated received-data inbox derived from runtime message events and grouped by connection, transport, sender, topic, and timestamp.
- Preserved the existing event-stream filtering and recipe workbench while adding the manual testing surface alongside it.
- Added focused tests for manual command generation, payload validation, received-message extraction, and recipe-snippet generation.
- Verified with `npm --workspace rallar-black-box run typecheck`.
- Verified with `npm --workspace rallar-black-box run build`.
- Verified with `npm run test -- packages/tests/rallar-black-box/control-bootstrap.test.ts packages/tests/rallar-black-box/control-client.test.ts packages/tests/rallar-black-box/manual-workbench.test.ts`.

Deliverables:

- manual action panel that still emits normal `rallar-bb-test` commands and results
- controls for environment, actor/session, group/room, connection name, target client, and transport
- action buttons for create or join group, connect clients in group, disconnect/reset, and health check
- JSON payload editor with validation, recent payload presets, and generated command preview
- send JSON to one client in a group over RTC or WebSocket
- broadcast or multicast JSON to all or selected clients in a group over RTC or WebSocket
- dedicated received-data inbox grouped by connection, transport, sender, topic, and timestamp
- links from each manual action to related results, diagnostics, stats, and received messages
- option to convert manual actions into a recipe snippet for repeatable test runs
- preservation of existing event-stream filtering for lower-level inspection

Rallar test focus:

- group membership correctness: expected clients, observed clients, missing clients, extra clients, and stale clients
- RTC versus WebSocket behavior parity for the same actors, groups, payloads, and delivery modes
- direct, multicast, and broadcast delivery semantics across RTC and WebSocket transports
- auth and permission negative cases for group creation, group join, client targeting, send, broadcast, and receive
- cleanup isolation between manual runs so stale sessions, old connections, and previous payloads do not contaminate the next test
- copyable manual action history that can become a repeatable recipe

### Iteration 13: RTC Connect Diagnostics Workbench

Make the sensitive RTC connect path easy to investigate from the visible app.

Status: completed.

Results:

- Added `apps/rallar-black-box/src/rtc-diagnostics.ts` with event-derived RTC diagnostics for connect stages, group membership, latency, failure focus, recent runtime events, recent command results, and copyable diagnostic bundles.
- Added topic and payload-phase mapping for auth, runtime bootstrap, group join, signaling, peer discovery, data-channel readiness, and first-payload stages.
- Added a visible RTC Diagnostics panel to the SPA with a connect-stage timeline, expected versus observed membership, missing/extra/stale client visibility, latency metrics, focused failure details, and copyable bundle output.
- Added reconnect, rejoin, health, close, cleanup, copy-bundle, and show-bundle operations from the diagnostics panel while still executing normal `rallar-bb-test` commands.
- Enriched the local fake RTC connect executor with staged runtime diagnostics so the diagnostics workbench can be exercised without a deployed Rallar service.
- Added focused tests proving diagnostics are derived from runtime events and command results rather than UI-only state.
- Verified with `npm --workspace rallar-black-box run build`.
- Verified with `npm run test -- packages/tests/rallar-black-box/control-bootstrap.test.ts packages/tests/rallar-black-box/control-client.test.ts packages/tests/rallar-black-box/manual-workbench.test.ts packages/tests/rallar-black-box/rtc-diagnostics.test.ts`.

Deliverables:

- connect-stage timeline for auth, runtime bootstrap, group join, signaling, peer discovery, data-channel readiness, and first payload
- side-by-side RTC and WebSocket connectivity checks for the same actor/group/client set
- visible peer/session/group membership state, including expected clients, observed clients, missing clients, and stale clients
- explicit reconnect, rejoin, close, and cleanup operations with before/after diagnostics
- connect health snapshot that includes recent diagnostics, stats, lane health, reconnect count, latency, and last received payload
- structured failure focus for common RTC issues: auth failure, group membership mismatch, peer not found, channel timeout, stale session, reconnect loop, and payload mismatch
- copyable diagnostic bundle for reproducing a failed connect path in a recipe or black-box runner test
- tests proving connect diagnostics are derived from runtime events rather than UI-only state

Rallar test focus:

- reconnect, rejoin, stale-session, and duplicate-session cases
- connect latency, first-payload latency, reconnect latency, and failure timeout timing
- RTC versus WebSocket connectivity checks for the same payload and target set
- group membership drift during reconnect and rejoin
- cleanup isolation after failed connects, cancelled connects, and closed connections
- copyable failure diagnostics that can become repeatable recipes

### Iteration 14: Graphology And Sigma Visualisation

Add an optional graph view for visible/debug runs.

Status: completed.

Results:

- Added `graphology` and `sigma` as direct dependencies of the black-box SPA.
- Added `apps/rallar-black-box/src/topology-graph.ts` with a graphology topology model derived from runtime config and runtime events.
- Modelled run, agent, actor, connection, room, session, and message/diagnostic nodes.
- Modelled control, identity, connection, membership, route, and diagnostic edges.
- Derived active, degraded, and failed status from event severity and diagnostic topic names, with status-aware node and edge coloring.
- Added deterministic graph layout by node kind so the view is stable across app renders and test runs.
- Added a Sigma.js topology panel to the React app with active/degraded/failed filters, summary metrics, visible node list, and recent RTC/WS route command links.
- Kept graph derivation local to the visible SPA and runtime event history, with no effect on headless command execution.
- Added focused tests for topology derivation, route edges, failed diagnostics, and filter counts.
- Verified with `npm --workspace rallar-black-box run build`.
- Verified with `npm run test -- packages/tests/rallar-black-box/topology-graph.test.ts packages/tests/rallar-black-box/rtc-diagnostics.test.ts packages/tests/rallar-black-box/manual-workbench.test.ts packages/tests/rallar-black-box/control-bootstrap.test.ts packages/tests/rallar-black-box/control-client.test.ts`.
- Verified with `npm run test:e2e:rallar-black-box`.

Deliverables:

- graphology topology model derived from runtime events
- Sigma.js renderer in the React app
- room, session, peer, and route views
- filters for active, degraded, and failed links
- no impact on headless execution

### Iteration 15A: Runtime Provider Selection

Make the SPA choose between simulated execution and real browser-Rallar execution explicitly.

Status: completed.

Results:

- Added centralized provider-mode defaults in `apps/rallar-black-box/src/client-defaults.ts`.
- Added provider mode parsing from URL params `provider` / `providerMode` and Vite env
  `VITE_RALLAR_PROVIDER` / `VITE_RALLAR_PROVIDER_MODE`.
- Default provider mode remains `simulated`, preserving the out-of-the-box local UI with no backend or login.
- Added optional real-provider auth bootstrap fields for future `browser-rallar` use: username, password, token,
  register, and restore-session flags.
- Added provider mode to bootstrap config, runtime config, manual workbench generated configure commands, control config,
  defaults, report snapshots, and report result rows.
- Added header, bootstrap, and configuration UI visibility for the active provider mode.
- Added provider validation for `browser-rallar`, requiring a non-demo API base URL plus username/password or
  `restoreSession=true`.
- Added explicit `browser-rallar` not-ready failures so real-provider mode cannot silently fall back to simulated RTC
  loopback before Iteration 15B is implemented.
- Preserved `rallar.bb.fake.*` topics for simulated execution.
- Added focused tests for default simulated provider behavior, URL/env provider selection, provider config validation,
  and manual configure command provider propagation.
- Verified with `npm --workspace rallar-black-box run build`.
- Verified with `npm run test -- packages/tests/rallar-black-box/control-bootstrap.test.ts packages/tests/rallar-black-box/manual-workbench.test.ts packages/tests/rallar-black-box/control-client.test.ts`.
- Verified with `npm run test:e2e:rallar-black-box`.

Deliverables:

- provider mode config through URL, Vite env, and visible UI state: `simulated` or `browser-rallar`
- default mode remains `simulated` so the UI works out of the box without a backend or login
- control-agent mode can opt into `browser-rallar` with `provider=browser-rallar` or equivalent env config
- header/bootstrap/configuration panels show the active provider mode
- command results and report summaries include the active provider mode
- simulated events keep the `rallar.bb.fake.*` topics
- real-provider events must never use `rallar.bb.fake.*` topics
- provider-specific config validation that fails early when `browser-rallar` is selected without required Rallar config
- focused tests proving default simulated behavior remains unchanged and real-provider mode is selected only when
  requested

### Iteration 15B: Browser Rallar Runtime Adapter For The SPA

Wire the existing browser Rallar facade into the SPA runtime.

Status: completed.

Results:

- Added `apps/rallar-black-box/src/browser-rallar-runtime.ts` as the SPA-safe bridge to the browser Rallar runtime.
- The bridge lazily imports `packages/shared-test/black-box-runner/browser/rallar-browser-runtime.ts` only when
  `browser-rallar` is active, preserving default Node tests and simulated UI startup.
- Connected `provider=browser-rallar` startup to `createRallarBlackBoxBrowserTestRuntime(...)`.
- Passed the SPA browser Rallar proxy as `rallarRuntime`, real browser `fetch`, and real browser `WebSocket` factory to
  the shared browser test runtime.
- Installed a `window.__blackBoxRallarEmit` bridge so real browser Rallar diagnostics, messages, and close events flow
  into the shared runtime event stream and existing UI selectors.
- Preserved the simulated provider as the default runtime path for offline UI and protocol development.
- Kept provider config validation before local/control bootstrap proceeds with `browser-rallar`.
- Added focused tests with a mocked `window.__blackBoxRallar` proving the SPA adapter proxies connect, send, health, and
  close and bridges browser events into runtime diagnostics.
- Verified with `npm --workspace rallar-black-box run build`.
- Verified with `npm run test -- packages/tests/rallar-black-box/browser-rallar-runtime.test.ts packages/tests/rallar-black-box/control-bootstrap.test.ts packages/tests/rallar-black-box/manual-workbench.test.ts packages/tests/rallar-black-box/control-client.test.ts packages/tests/rallar-black-box/rtc-diagnostics.test.ts packages/tests/rallar-black-box/topology-graph.test.ts`.
- Verified with `npm run test:e2e:rallar-black-box`.

Deliverables:

- create a SPA-safe browser Rallar runtime adapter around `packages/shared-web/browser/rallar.ts` or the reusable pieces
  from `packages/shared-test/black-box-runner/browser/rallar-browser-runtime.ts`
- connect the adapter to `createRallarBlackBoxBrowserTestRuntime(...)` from
  `packages/shared-test/rallar-bb-test/browser-adapter.ts`
- map `configure` and `rtc.connect` config into real `rallar.configure`, auth restore/login/register, `rallar.connect`,
  room join, and subscription setup
- bridge real browser Rallar diagnostics and message callbacks into the shared runtime event stream
- support real `health`, `close`, and `reset` behavior, including unsubscribe and disconnect cleanup
- preserve browser-native real `fetch` and `WebSocket` execution for `http.request`, `ws.open`, `ws.send`, and
  `ws.close`
- keep the simulated provider isolated so tests and local UI development do not require a deployed Rallar service
- focused unit tests with mocked Rallar facade proving connect/send/close call the real adapter methods rather than the
  fake executor

### Iteration 15C: Real RTC Connect And Send Smoke

Prove the SPA can perform actual Rallar RTC signaling and payload sending against a configured environment.

Status: completed for the gated smoke harness; live execution is skipped unless real Rallar environment variables are
provided.

Results:

- Tightened `browser-rallar` provider validation to match the actual browser runtime auth modes: a real API base URL plus
  username/password login or `restoreSession=true`.
- Stopped treating a bare `rallarToken` / `VITE_RALLAR_TOKEN` value as sufficient provider auth. Restored-session mode
  needs a complete browser auth session, not only an access token.
- Kept the simulated provider as the out-of-the-box default and kept real-provider mode opt-in through URL or Vite env.
- Added a non-gated SPA adapter test proving configured `rtc.connect` and `rtc.send` commands call
  `window.__blackBoxRallar.connect(...)` and `window.__blackBoxRallar.send(...)` instead of the fake executor.
- Added `tests/playwright/rallar-black-box/browser-rallar-real-smoke.spec.ts`, an environment-gated Playwright smoke that
  starts a control-agent SPA with `provider=browser-rallar`, enqueues a real `rtc.connect`, enqueues a realtime
  `rtc.send`, waits for successful command results, and asserts real browser topics are present while
  `rallar.bb.fake.*` topics are absent.
- The live smoke is skipped by default and runs only when `VITE_RALLAR_API_BASE_URL`, `VITE_RALLAR_ROOM_ID`, and either
  `VITE_RALLAR_USERNAME` / `VITE_RALLAR_PASSWORD` or a restorable `VITE_RALLAR_*` browser session are provided.
- Documented the current provider reality, live-smoke environment variables, and the distinction between simulated local
  runs and real `browser-rallar` runs.
- Local verification covered the harness and mocked command path. No live Rallar environment variables were available in
  this workspace, so the real smoke was not executed against a deployed Rallar service here.
- Fixed the shared runtime so command executors receive raw config while UI state, reports, events, and results keep
  redacted config. Without this, `browser-rallar` login would receive a redacted password.
- Verified with `npm run test -- packages/tests/rallar-black-box/browser-rallar-runtime.test.ts packages/tests/rallar-black-box/control-bootstrap.test.ts packages/tests/shared-test/rallar-bb-test.test.ts`.
- Verified with `npm --workspace @ar-eye-hunter/shared-test run typecheck`.
- Verified with `npm --workspace rallar-black-box run typecheck`.
- Verified with `npm --workspace rallar-black-box run build`.
- Verified with `npm run test:e2e:rallar-black-box`; the live browser-Rallar smoke skipped as intended without real
  environment variables, and the existing control-agent smoke passed.

Deliverables:

- real `rtc.connect` path that performs auth, Rallar connect, room join, peer discovery subscription, and data-channel or
  `messages.rtc` subscription
- real `rtc.send` path for `rallar.realtime.sendJson`
- real `rtc.send` path for `rallar.messages.rtc.send`
- direct, multicast, and broadcast send mapping for `realtime` and `messages.rtc`
- visible distinction between real received messages and simulated loopback messages
- manual workbench sends use the real provider when `browser-rallar` mode is active
- RTC diagnostics consume real browser topics such as `rallar.browser.connect.phase_started`,
  `rallar.browser.connect.phase_completed`, `rallar.browser.connect.phase_failed`, `rallar.browser.realtime.message`,
  and `rallar.browser.messages.rtc.message`
- environment-gated smoke tests that run only when Rallar API base URL, room ID, and username/password or a restorable
  browser auth session are provided
- non-gated tests with mocked Rallar facade proving the command path performs actual connect/send calls

### Iteration 16: Two-agent Real RTC Delivery

Prove real delivery between at least two browser agents.

Status: completed for the gated two-agent smoke harness; live execution is skipped unless real Rallar environment
variables are provided.

Results:

- Added `tests/playwright/rallar-black-box/browser-rallar-two-agent-smoke.spec.ts`.
- The new gated Playwright smoke starts two isolated browser contexts as two SPA control agents in the same run and room.
- Each agent can use explicit two-agent login env vars, generic username/password login env vars in isolated browser
  contexts, or explicit per-agent restored browser sessions.
- The realtime smoke connects agent A and agent B, extracts real Rallar session IDs from connect results, sends A to B
  with `rallar.realtime.sendJson`, sends B to A, and asserts the receiving page's Received Data inbox contains each
  payload.
- The `messages.rtc` smoke performs the same two-agent delivery flow with `rallar.messages.rtc.send`, using
  `VITE_RALLAR_MESSAGES_RTC_TYPE_ID` / `VITE_RALLAR_TYPE_ID` and
  `VITE_RALLAR_MESSAGES_RTC_TOPIC_ID` / `VITE_RALLAR_TOPIC_ID` when provided.
- The smoke also runs health, stats, final-report recipe, close, and reset commands for both agents.
- The control-server run snapshot is asserted to contain both agents, successful command results, both delivery message
  events, stats envelopes from both agents, final report envelopes from both agents, and no `rallar.bb.fake.*` topics.
- Fixed topology derivation for real browser received-message events so `remotePeerId` / `senderId` are treated as the
  sender and `peerId` is treated as the receiving session.
- Added topology coverage proving real `rallar.browser.realtime.message` and
  `rallar.browser.messages.rtc.message` events derive sender-to-receiver route edges.
- Multicast/broadcast real-delivery assertions and missing/stale-agent negative matrices are not exercised by this
  smoke; they remain better suited to the next real-provider hardening and larger multi-agent iterations.
- Local verification covered the harness and topology behavior. No live Rallar environment variables were available in
  this workspace, so the two-agent realtime and `messages.rtc` smokes were not executed against a deployed Rallar
  service here.
- Verified with `npm run test -- packages/tests/rallar-black-box/topology-graph.test.ts packages/tests/rallar-black-box/browser-rallar-runtime.test.ts packages/tests/rallar-black-box/control-bootstrap.test.ts packages/tests/shared-test/rallar-bb-test.test.ts`.
- Verified with `npm --workspace rallar-black-box run typecheck`.
- Verified with `npm --workspace @ar-eye-hunter/shared-test run typecheck`.
- Verified with `npm --workspace rallar-black-box run build`.
- Verified with `npm run test:e2e:rallar-black-box`; the one-agent and two-agent live browser-Rallar smokes skipped as
  intended without real environment variables, and the existing control-agent smoke passed.

Deliverables:

- Playwright or black-box-runner flow that starts two SPA agents with the same run/room and different actors/sessions
- control-server orchestration for agent A connect, agent B connect, A sends to B, B sends to A, health, close, and reset
- received-data inbox shows real inbound payloads on the receiving agent
- control-server run snapshot captures both agents' command results, message events, diagnostics, stats, and reports
- topology view derives real room membership and route edges from real event streams
- direct delivery assertion for `realtime`
- direct delivery assertion for `messages.rtc`
- multicast and broadcast assertions when the target Rallar environment supports enough peers
- timeout diagnostics when one agent is missing, stale, or not joined

### Iteration 17: Real Provider Auth, Permissions, And Cleanup

Make real-provider failures useful and safe to run repeatedly.

Status: planned.

Results:

- Not started.

Deliverables:

- documented config for username/password, restore-session, registration, token, and logout behavior
- redaction tests for real auth fields, tokens, tickets, authorization headers, and session identifiers
- negative tests for bad credentials, missing token, forbidden room join, forbidden send target, and expired session
- real cleanup path for unsubscribe, room leave when available, disconnect, logout when requested, and browser storage
  cleanup
- stale-session and duplicate-session diagnostics using real Rallar events where available
- copyable failure bundles that include provider mode, Rallar environment, actor/session/room, command IDs, connect
  phases, and redacted auth state
- control-server rejection remains separate from real Rallar auth/permission failure so the UI can distinguish local
  command validation from remote service denial

### Iteration 18: Real Provider Runner Parity

Make recipes portable between local visible UI, remote SPA agents, and the existing black-box runner provider.

Status: planned.

Results:

- Not started.

Deliverables:

- recipe examples that can run through the visible SPA provider and the black-box runner `rallar-browser` or
  `rallar-remote-browser` provider
- report comparison for local Playwright provider versus remote SPA provider using the shared result/event vocabulary
- parity checks for connect, direct send, multicast/broadcast metadata, received messages, health, close, and reset
- provider-specific report fields clearly marked so comparisons do not fail on expected environment differences
- CLI or test helper documentation for launching the SPA as a real provider agent
- regression tests that prevent the SPA real-provider command mapping from drifting from the runner mapping

### Iteration 19: Long-running And Randomised Runs

Integrate with the planned soak and seeded-random test work after real provider smoke and two-agent delivery are proven.

Status: planned.

Results:

- Not started.

Deliverables:

- long-running run status
- periodic report checkpoints
- support for seeded randomized command subsets
- clear distinction between randomized and non-randomized steps
- provider mode included in random-run metadata
- server-side visibility into random seed, iteration, selected command order, provider mode, actor/session, and room
- real-provider cleanup checkpoints between randomized command groups
- failure bundles that can replay the selected seed and command order against the same provider mode

## Concerns

Remote browser control is a security-sensitive capability. The app should never accept arbitrary JavaScript or
unvalidated command payloads from the server.

Long-running browser runs need careful cleanup. Reconnect, reset, and close semantics should be deterministic enough
that failed runs do not poison the next run.

The app must treat credentials and session tokens as secrets. Diagnostics and reports should redact passwords, tickets,
authorization headers, and any configured secret fields.

WebSocket is best for live control and low-latency telemetry, but REST remains useful for large artifacts and durable
final report submission.

Graph visualisation can become expensive for large runs. It should be sampled, filtered, and optional.

## Open Questions

- Should the control server live in `apps/api-v1`, black-box-runner, `apps/rallar-monitor-server`, or more than one of
  these behind the same protocol?
- When should `packages/shared-test/rallar-bb-test` be promoted from a folder inside `@ar-eye-hunter/shared-test` to a
  separate workspace package?
- Should agents be pre-registered by the server, or should they self-register using a signed run token?
- What exact split should we keep between the reusable facade runtime and the thin Playwright
  `rallar-browser-runtime.ts` adapter?
- Should the first remote SPA support only one actor/session per loaded page, or should multi-actor pages be supported
  later through an explicit runtime model?
- Which real-provider auth mode should be the first supported default: restore existing session, username/password login,
  registration plus login, short-lived test token, or more than one mode?
- Should `browser-rallar` mode be allowed from the visible UI controls, or only from URL/env bootstrap so accidental real
  network traffic is harder to trigger?
- What default HTTP and WebSocket destination allowlists should browser-native commands use?
- What report storage format should the server use for long-running test reports?

## References

- Graphology: https://graphology.github.io/
- Sigma.js: https://www.sigmajs.org/
