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

### Iteration 9: Black-box Runner Remote Provider

Teach black-box-runner to target a remote SPA agent in addition to the local Playwright harness.

Status: planned.

Results:

- Not started.

Possible provider name:

```text
rallar-remote-browser
```

Deliverables:

- runner provider that sends facade commands over the control server
- mapping from black-box runner RTC, WebSocket, and HTTP actions to remote commands
- reuse of existing report collection where possible
- timeout and disconnect diagnostics
- compatibility tests proving local `rallar-browser` and remote `rallar-remote-browser` report comparable outcomes

### Iteration 10: Periodic Stats And Report Uploads

Add periodic stats and final report streaming.

Status: planned.

Results:

- Not started.

Deliverables:

- stats interval config
- WebSocket stats events
- REST final-report upload option
- report redaction
- server-side storage or file output for collected reports

### Iteration 11: Security And Operational Hardening

Harden the remote-control surface before any broad deployment.

Status: planned.

Results:

- Not started.

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

### Iteration 12: Graphology And Sigma Visualisation

Add an optional graph view for visible/debug runs.

Status: planned.

Results:

- Not started.

Deliverables:

- graphology topology model derived from runtime events
- Sigma.js renderer in the React app
- room, session, peer, and route views
- filters for active, degraded, and failed links
- no impact on headless execution

### Iteration 13: Long-running And Randomised Runs

Integrate with the planned soak and seeded-random test work.

Status: planned.

Results:

- Not started.

Deliverables:

- long-running run status
- periodic report checkpoints
- support for seeded randomized command subsets
- clear distinction between randomized and non-randomized steps
- server-side visibility into random seed, iteration, and selected command order

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
- What default HTTP and WebSocket destination allowlists should browser-native commands use?
- What report storage format should the server use for long-running test reports?

## References

- Graphology: https://graphology.github.io/
- Sigma.js: https://www.sigmajs.org/
