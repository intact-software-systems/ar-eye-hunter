# Black-box Rallar Implementation Plan

## Goal

`apps/rallar-black-box` should become a deployable, remote-controlled browser SPA for black-box Rallar RTC, WebSocket, and HTTP testing.

The app should let a browser register with a control server, receive test recipes and commands over WebSocket, execute those commands through Rallar or browser-native HTTP/WebSocket APIs, and stream events, diagnostics, stats, and reports back to the server.

The first production shape is still headless-first. A visible UI is useful for debugging and operations, but the primary path should work when the black-box runner starts a headless browser and points it at this app.

## Boundary

The existing `packages/shared-test/black-box-runner/browser` harness is not the production app. It is a minimal Playwright harness for local test execution.

`apps/rallar-black-box` should be the deployable browser agent:

```text
black-box runner or control service
    -> WebSocket or REST control plane
        -> apps/rallar-black-box
            -> shared-test black-box Rallar facade
                -> browser Rallar facade
                    -> deployed Rallar REST API, signaling, and RTC data paths
```

The app should not reimplement WebRTC, signaling, room membership, or Rallar routing. It should delegate that work to the existing browser Rallar facade.

## App Shape

Use React plus Vite, consistent with the other app packages.

The app should include:

- headless-safe startup with configuration from URL, environment, or bootstrap endpoint
- a WebSocket control client
- a command dispatcher for RTC, WebSocket, and HTTP test actions
- a compact status/debug UI for local and visible runs
- event, diagnostic, stats, and report streaming
- strict schema validation at the control boundary
- redaction of credentials and sensitive payload fields

The UI should be operational rather than a landing page: connection state, active run, current actor/session, command log, recent messages, health stats, and failures.

## Shared-test Facade

There does not appear to be a dedicated shared-test facade yet for this role.

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

The current `rallar-browser-runtime.ts` can inform the facade, but the new facade should avoid depending on Playwright globals such as `window.__blackBoxRallar`.

## Recipe Scope

The app should execute recipes sent from the server. A recipe is an ordered or partially parallel plan of commands with expectations, timeouts, and reporting rules.

Initial recipe families:

| Family | Purpose |
| --- | --- |
| RTC | Exercise `rallar.realtime`, `rallar.messages.rtc`, room membership, peer links, and RTC payload delivery. |
| WebSocket | Exercise raw WebSocket endpoints, Rallar WebSocket topics, reconnect behavior, and server push paths. |
| HTTP | Exercise REST endpoints, auth flows, bootstrap/config endpoints, report uploads, and API failure behavior. |

The recipe model should keep transport-specific details in command payloads while using a shared envelope for command IDs, timing, status, diagnostics, stats, and report fragments.

## Control Protocol

Use WebSocket as the primary control channel. The browser initiates the socket connection, then the server pushes commands over that open connection.

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

The protocol should require stable command IDs. Results should be replay-safe so reconnects do not duplicate irreversible work.

## Command Set

Initial commands:

| Command | Purpose |
| --- | --- |
| `configure` | Set API base URL, actor identity, transport, room, and test defaults. |
| `rtc.connect` | Authenticate, connect Rallar, join room, and start selected RTC listeners. |
| `rtc.send` | Send over `rallar.realtime` or `rallar.messages.rtc`. |
| `ws.open` | Open a raw or Rallar WebSocket connection. |
| `ws.send` | Send a WebSocket message. |
| `ws.close` | Close a WebSocket connection and report close diagnostics. |
| `http.request` | Execute a browser HTTP request and report status, headers, timing, and selected response data. |
| `health` | Return Rallar status, RTC lane health, counters, and current session metadata. |
| `stats` | Return a stats snapshot without changing connection state. |
| `close` | Close listeners and disconnect/log out according to config. |
| `reset` | Clear runtime state after a run or failed setup. |

`rallar.realtime` versus `rallar.messages.rtc` should be a configuration option on `configure`, `connect`, or the individual `send` command.

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

Reports should reuse the black-box runner report vocabulary where possible so local headless runs and remote SPA runs can be compared.

## Graph Visualisation

Graph visualisation should be a later iteration.

Use `graphology` for the graph data model. Use Sigma.js for browser rendering when we need an interactive graph view; Sigma.js is built around rendering graphology graphs in the browser.

Useful graph views:

- agent topology by `agentId`
- Rallar sessions by session ID
- rooms and membership
- observed RTC peer links
- message routes for `messages.rtc`
- failed or degraded links highlighted by recent diagnostics

The graph should be derived from events and stats. It should not become a required dependency for headless execution.

## Proposed Iterations

### Iteration 1: Planning Document

Create this implementation plan and agree on app, facade, and protocol boundaries.

Status: documented.

### Iteration 2: React App Scaffold

Create `apps/rallar-black-box` as a Vite React app with package scripts, TypeScript config, Vite aliases, and a minimal operational UI.

Deliverables:

- app shell
- status panel
- command/event log panel
- build and typecheck scripts
- no WebSocket dependency yet

### Iteration 3: `rallar-bb-test` Facade Skeleton

Create `packages/shared-test/rallar-bb-test` with command, result, event, stats, and report types.

Deliverables:

- typed command contract
- runtime interface
- no-op or fake runtime for UI and protocol testing
- redaction helpers
- tests for command/result serialization

### Iteration 4: Browser Runtime Adapters

Move reusable browser runtime behavior behind the new facade.

Deliverables:

- adapter from `RallarBlackBoxTestCommand` to browser Rallar facade calls
- adapter from facade commands to browser-native `fetch`
- adapter from facade commands to browser-native `WebSocket`
- support for `configure`, `rtc.connect`, `rtc.send`, `ws.open`, `ws.send`, `ws.close`, `http.request`, `health`, `stats`, `close`, and `reset`
- transport option for `realtime` and `messages.rtc`
- event bridge from Rallar callbacks, WebSocket callbacks, and HTTP results to facade events

### Iteration 5: Local Command Harness

Let the React app execute commands locally from a development panel or local JSON input.

Deliverables:

- manual command execution without a server
- visible results and diagnostics
- test fixtures for common command sequences
- parity check against the existing Playwright harness behavior
- local RTC, WebSocket, and HTTP recipe examples

### Iteration 6: WebSocket Control Client

Add the remote control WebSocket client to the SPA.

Deliverables:

- agent registration
- heartbeat and reconnect
- command dispatch by command ID
- result and event streaming
- protocol version checks
- client-side schema validation

### Iteration 7: Control Server Integration

Add or integrate a server endpoint that can register agents, send commands, collect results, and expose run state.

Open decision:

- add this to `apps/api-v1` if it belongs to deployed Rallar infrastructure
- add a black-box-runner control server if it belongs to test orchestration
- support both later with the same protocol

Deliverables:

- WebSocket endpoint for agents
- run and agent registry
- command queue
- result/event ingestion
- authentication and token issuance

### Iteration 8: Black-box Runner Remote Provider

Teach black-box-runner to target a remote SPA agent in addition to the local Playwright harness.

Possible provider name:

```text
rallar-remote-browser
```

Deliverables:

- runner provider that sends facade commands over the control server
- mapping from black-box runner RTC, WebSocket, and HTTP actions to remote commands
- reuse of existing report collection where possible
- timeout and disconnect diagnostics

### Iteration 9: Periodic Stats And Report Uploads

Add periodic stats and final report streaming.

Deliverables:

- stats interval config
- WebSocket stats events
- REST final-report upload option
- report redaction
- server-side storage or file output for collected reports

### Iteration 10: Security And Operational Hardening

Harden the remote-control surface before any broad deployment.

Deliverables:

- short-lived run tokens
- strict command schema validation
- command allowlist
- origin and TLS requirements
- sensitive field redaction
- result replay after reconnect
- command idempotency rules
- rate limits and payload size limits

### Iteration 11: Graphology And Sigma Visualisation

Add an optional graph view for visible/debug runs.

Deliverables:

- graphology topology model derived from runtime events
- Sigma.js renderer in the React app
- room, session, peer, and route views
- filters for active, degraded, and failed links
- no impact on headless execution

### Iteration 12: Long-running And Randomised Runs

Integrate with the planned soak and seeded-random test work.

Deliverables:

- long-running run status
- periodic report checkpoints
- support for seeded randomized command subsets
- clear distinction between randomized and non-randomized steps
- server-side visibility into random seed, iteration, and selected command order

## Concerns

Remote browser control is a security-sensitive capability. The app should never accept arbitrary JavaScript or unvalidated command payloads from the server.

Long-running browser runs need careful cleanup. Reconnect, reset, and close semantics should be deterministic enough that failed runs do not poison the next run.

The app must treat credentials and session tokens as secrets. Diagnostics and reports should redact passwords, tickets, authorization headers, and any configured secret fields.

WebSocket is best for live control and low-latency telemetry, but REST remains useful for large artifacts and durable final report submission.

Graph visualisation can become expensive for large runs. It should be sampled, filtered, and optional.

## Open Questions

- Should the control server live in `apps/api-v1`, in black-box-runner, or both?
- Should `rallar-bb-test` be a folder inside `@ar-eye-hunter/shared-test` first, or a separate workspace package later?
- Should agents be pre-registered by the server, or should they self-register using a signed run token?
- How much of the current `rallar-browser-runtime.ts` should move into the facade versus remain as a Playwright harness adapter?
- What report storage format should the server use for long-running test reports?

## References

- Graphology: https://graphology.github.io/
- Sigma.js: https://www.sigmajs.org/
