# Command Execution

Rallar Black Box commands are defined by the shared `rallar-bb-test` contract. The SPA, the control client, the control
server, and runner adapters all use this command vocabulary.

## Command Kinds

| Command | Purpose |
| --- | --- |
| `configure` | Set run ID, agent ID, environment, API base URL, actor, session, room, transport, defaults, and redaction. |
| `recipe.load` | Validate and load a recipe without running it. |
| `recipe.run` | Run the loaded recipe or an inline recipe. |
| `recipe.cancel` | Request cancellation of a running recipe. |
| `rtc.connect` | Connect an RTC-capable Rallar client for an actor and room. |
| `rtc.send` | Send a payload over `realtime` or `messages.rtc`. |
| `ws.open` | Open a browser WebSocket connection. |
| `ws.send` | Send data over an opened WebSocket connection. |
| `ws.close` | Close a WebSocket connection. |
| `http.request` | Execute a browser HTTP request and capture selected response data. |
| `health` | Return current health without changing connection state. |
| `stats` | Return a stats snapshot. |
| `close` | Close runtime connections. |
| `reset` | Clear runtime state before the next run. |

Every command should have a stable `commandId` when it is used in recipes or remote control. Stable IDs make duplicate
delivery and reconnect replay safe.

## Local UI Path

Local UI actions follow this path:

```text
UI panel
  -> command builder or JSON parser
  -> runtime store
  -> rallar-bb-test runtime.execute(...)
  -> SPA command executor
  -> runtime result, events, stats, and failures
  -> React selectors and panels
```

Current implementation detail: the default provider is the local/fake executor in `src/runtime-store.ts`. It creates
real runtime state and realistic diagnostic/message events for offline UI work. When `provider=browser-rallar` is
selected with real Rallar config, runner-owned command tabs use the browser adapter and call the browser Rallar facade
for RTC, WebSocket, HTTP, health, close, and reset behavior.

The `Auth`, `Groups/Clients`, `WebSocket`, and `Rallar Server` tabs can also execute focused REST calls directly from the
browser. Those calls are immediate `fetch` operations, not runtime commands. The focused Auth and Groups/Clients actions
keep their own visible action logs and can copy recipe snippets. Groups/Clients, WebSocket, and RTC/Realtimes also show
a latest-action status strip with target, status, duration, and error text so a button press has immediate visible
feedback. In Rallar mode, the WebSocket tab sends and subscribes through the shared browser Rallar facade
(`rallar.messages.ws.*`) and records `rallar.direct.*` diagnostics instead of executing runtime `ws.send` commands. Its
lower-level raw socket/ticket diagnostics use browser REST/WebSocket APIs directly. The Rallar Server tab can copy the
selected request as a black-box `http.request` command when the same request should become part of a repeatable recipe
or remote-control run.
Its REST Collection area also executes browser `fetch` calls directly, evaluates command-center assertions locally, and
copies the flow as `http.request` recipe commands with assertion/extraction metadata for later runner or control-server
use.

Browser-executed commands can use logged-in session placeholders when the SPA is running with `provider=browser-rallar`:

- `{auth.clientId}`
- `{auth.username}`
- `{auth.sessionId}`
- `{auth.accessToken}`
- `{auth.wsTicket}`
- `{config.apiBaseUrl}`
- `{config.wsBaseUrl}`

The placeholders are resolved inside `http.request`, `ws.open`, `rtc.connect`, and `rtc.send` commands. The
`{auth.wsTicket}` placeholder is special: `ws.open` requests a fresh `/api/auth/ws-ticket` using the logged-in browser
session before opening the WebSocket URL. This lets static recipe JSON open API-v1 WebSockets without storing one-time
tickets in the recipe file. Browser Rallar signaling follows the same rule: because API-v1 consumes a WS ticket during
socket upgrade, reconnects must request a new ticket instead of reusing the original WebSocket URL.

RTC commands can carry scoped Rallar addressing fields directly on `rtc.connect` and `rtc.send`: `applicationId`,
`workspaceId`, `scope`, `roomRef`, and `minSnapshotVersion`. Manual Rallar exposes these fields and the browser adapter
passes them through to the real provider instead of inferring them in the SPA.

Real-provider cleanup is observable. Close/reset commands unsubscribe realtime and `messages.rtc` listeners, leave the
joined room by default, then either disconnect or log out when `rallarLogoutOnClose=1` is configured. Remote reset
commands also clear browser `localStorage` and `sessionStorage` before executing the runtime reset.

## Remote Control Path

Remote commands follow this path:

```text
REST client or runner
  -> POST /runs/:runId/agents/:agentId/commands
     or POST /runs/:runId/commands for selected-agent bulk enqueue
  -> in-memory control server validation and queue
  -> WebSocket /control
  -> browser control client
  -> parse and validate command envelope
  -> rallar-bb-test runtime.execute(...)
  -> result envelope plus event, stats, and report envelopes
  -> control server run snapshot
```

The browser initiates the WebSocket connection. The server does not reach into the browser directly.

## Provider Parity Helpers

`packages/shared-test/rallar-bb-test/provider-parity.ts` provides the portable Iteration 18 parity path:

- `createRallarBlackBoxProviderParityRecipe(...)` builds a visible SPA recipe for configure, connect, direct send,
  multicast metadata, broadcast metadata, health, close, and reset.
- `toRallarBlackBoxRunnerParityInteractions(...)` converts that recipe to runner RTC interactions for `rallar-browser`
  or `rallar-remote-browser`.
- `normalizeRallarBlackBoxRuntimeParityReport(...)`, `normalizeBlackBoxRunnerParityReport(...)`, and
  `compareRallarBlackBoxProviderParityReports(...)` compare shared command/result semantics while keeping
  provider-specific fields under `providerSpecific`.

The runner conversion executes RTC `connect`, `send`, optional receive `wait`, and `close` operations. It records
`configure`, `health`, and `reset` as explicit omissions because those operations exist in the SPA command vocabulary but
not as first-class runner RTC provider actions.

The same parity metadata is preserved through the runtime facade adapter and the remote SPA provider, so drift in
connect, send, and close command mapping is covered by shared-test regression tests.

## Shared-test Runner Path

`packages/shared-test/black-box-runner` is the external JSON recipe executor. It runs HTTP, WS, RTC, ASSERT, and SET
steps with provider-neutral requests, responses, expectations, reports, and artifacts. It is not a Rallar
reimplementation.

Runner scenarios can target deterministic providers, real browser providers, or remote visible browser agents:

```text
recipe-matrix entry or JSON scenario
  -> black-box-runner scenario CLI
  -> HTTP, WS, RTC, ASSERT, SET step execution
  -> provider-specific adapters where needed
  -> report.json, events.jsonl, failures.json, metadata.json
  -> optional artifact-index.json, expanded-recipe.json, expanded-plan.json, reduced-plan.json, or matrix-summary.json
```

The SPA `Shared Test` tab consumes only the stable handoff layer:

- `RALLAR_BLACK_BOX_SHARED_TEST_RECIPE_CATALOG`
- `RALLAR_BLACK_BOX_SHARED_TEST_ARTIFACT_CONTRACT`
- `RALLAR_BLACK_BOX_SHARED_TEST_COVERAGE_HANDOFF`
- `parseRallarBlackBoxSharedTestArtifactBundle(...)`

The browser UI displays catalog entries, copies commands, and imports redacted artifacts through those contracts. It
does not parse runner internals or silently execute shell commands.

## Flow Builder Path

The `Flow Builder` tab stores an editable flow JSON document plus variables JSON. It resolves placeholders, generates a
normal `rallar-bb-test` recipe, and runs that recipe through `recipe.run`. It can also export a black-box-runner-style
scenario with variables, connections, and HTTP/WS/RTC steps. The browser still executes only the generated SPA recipe;
runner execution remains explicit local tooling.

## Control Envelopes

Server to browser:

```json
{
  "kind": "command",
  "protocolVersion": 1,
  "runId": "demo-run",
  "agentId": "agent-1",
  "commandId": "stats-1",
  "command": {
    "kind": "stats",
    "commandId": "stats-1"
  }
}
```

Browser to server result:

```json
{
  "kind": "result",
  "protocolVersion": 1,
  "runId": "demo-run",
  "agentId": "agent-1",
  "commandId": "stats-1",
  "ok": true,
  "result": {
    "commandId": "stats-1",
    "kind": "stats",
    "status": "ok",
    "ok": true,
    "startedAtEpochMs": 1760000000000,
    "endedAtEpochMs": 1760000000010,
    "durationMs": 10
  }
}
```

Browser to server event, diagnostic, stats, or report:

```json
{
  "kind": "diagnostic",
  "protocolVersion": 1,
  "runId": "demo-run",
  "agentId": "agent-1",
  "atEpochMs": 1760000000000,
  "eventId": "event-1",
  "commandId": "rtc-connect-1",
  "payload": {
    "kind": "diagnostic",
    "topic": "rallar.bb.fake.rtc.connected"
  }
}
```

## Posting A Command

With the control server running and a browser agent registered as `demo-run` / `agent-1`:

```sh
curl -X POST http://localhost:5180/runs/demo-run/agents/agent-1/commands \
  -H 'Content-Type: application/json' \
  -d '{
    "commandId": "health-1",
    "command": {
      "kind": "health",
      "commandId": "health-1"
    }
  }'
```

Inspect the run:

```sh
curl 'http://localhost:5180/runs/demo-run?limitCommands=50&limitEvents=50&limitHeartbeats=20'
```

Queue the same command to multiple browser agents:

```sh
curl -X POST http://localhost:5180/runs/demo-run/commands \
  -H 'Content-Type: application/json' \
  -d '{
    "agentIds": ["agent-1", "agent-2"],
    "commandIdPrefix": "health-bulk",
    "command": {
      "kind": "health"
    }
  }'
```

Reset or delete the in-memory run snapshot:

```sh
curl -X POST http://localhost:5180/runs/demo-run/reset
curl -X DELETE http://localhost:5180/runs/demo-run
```

Export attachable run artifacts:

```sh
curl http://localhost:5180/runs/demo-run/artifacts
curl http://localhost:5180/runs/demo-run/artifacts/report.json
curl http://localhost:5180/runs/demo-run/events.jsonl
curl http://localhost:5180/runs/demo-run/results.jsonl
curl http://localhost:5180/runs/demo-run/failure-bundle
```

Enable local file-backed snapshot persistence for the control server:

```sh
RALLAR_BLACK_BOX_STORAGE_DIR=.artifacts/rallar-black-box-control \
  npm run start:rallar:control
```

Persisted snapshots are restored as disconnected runs on startup. Agents need to reconnect before queued commands can be
dispatched again.

Limit retained local runs and apply cleanup explicitly:

```sh
RALLAR_BLACK_BOX_RETENTION_MAX_RUNS=20 npm run start:rallar:control
curl -X POST http://localhost:5180/retention/cleanup
```

The bare request above remains the legacy destructive operation. New operator
flows must preview first; the server does not read a request body for any of
these forms:

```sh
curl -X POST 'http://localhost:5180/retention/cleanup?dryRun=true'

# Copy the opaque planToken from the preview only after reviewing every
# wouldDeleteRuns, linked distributed run, and fleet report consequence.
PLAN_TOKEN='v1...'
curl -X POST --get \
  --data-urlencode "planToken=${PLAN_TOKEN}" \
  http://localhost:5180/retention/cleanup
```

Confirmation succeeds only while the authorized server process, configured
cap, candidates, connected-agent/token state, and full linked contents still
match the preview. Drift or expiry returns `409` without deletion and requires
a new dry run. A dry run removes nothing. Successful legacy cleanup or guarded
confirmation removes in-memory control, distributed, and linked fleet state
only; it does not close current agent sockets or delete stored artifact files.
Use the existing admin/operator authorization when the server is configured to
require it.

## Example Commands

Configure:

```json
{
  "kind": "configure",
  "commandId": "configure-1",
  "config": {
    "runId": "demo-run",
    "agentId": "agent-1",
    "environment": "local",
    "apiBaseUrl": "https://api.example.invalid",
    "actor": "alice",
    "sessionId": "alice-session",
    "roomId": "demo-room",
    "transport": "realtime",
    "defaults": {
      "connection": "aliceRtc",
      "timeoutMs": 5000
    }
  }
}
```

RTC connect:

```json
{
  "kind": "rtc.connect",
  "commandId": "rtc-connect-1",
  "connection": "aliceRtc",
  "actor": "alice",
  "roomId": "demo-room",
  "transport": "realtime",
  "rallar": {
    "sessionId": "alice-session"
  },
  "timeoutMs": 5000
}
```

RTC direct send:

```json
{
  "kind": "rtc.send",
  "commandId": "rtc-send-1",
  "connection": "aliceRtc",
  "transport": "realtime",
  "send": {
    "roomId": "demo-room",
    "peerIds": ["bob-session"],
    "data": {
      "topic": "manual.ping",
      "seq": 1
    }
  }
}
```

WebSocket open and send:

```json
{
  "kind": "ws.open",
  "commandId": "ws-open-1",
  "connection": "control",
  "url": "wss://control.example.invalid/runs/demo-run"
}
```

```json
{
  "kind": "ws.send",
  "commandId": "ws-send-1",
  "connection": "control",
  "data": {
    "kind": "ping",
    "seq": 1
  }
}
```

When the SPA runs in `browser-rallar` mode and the Rallar signaling socket is already open, the same `ws.send` command
can route through `rallar.messages.ws.send(...)` instead of a raw command-center WebSocket. Room-scoped app messages
should include the Rallar addressing envelope used by the WebSocket tab. The WebSocket tab defaults to the
room-scoped group-message preset and follows the joined/global group promoted by Quick Test, Manual Rallar, or
Groups/Clients create/join actions:

```json
{
  "kind": "ws.send",
  "commandId": "ws-send-group-1",
  "connection": "rallarApi",
  "data": {
    "applicationId": "ar-eye-hunter",
    "workspaceId": "default",
    "scope": "room",
    "roomId": "bb-group",
    "groupId": "bb-group",
    "typeId": "room.manual.message",
    "topicId": "room.manual.message",
    "contextId": "bb-group",
    "payload": {
      "text": "hello group"
    }
  }
}
```

Receiving browsers need a matching `rallar.messages.ws.onMessage(...)` subscription for the selected type/topic. Rallar
Server user WebSocket topics must use an `app.` or `room.` prefix; the SPA defaults to `room.manual.message` for group
delivery and validates the topic before sending so a server-side reject does not look like a successful delivery. The
WebSocket tab's `Subscribe WS` action installs that subscription directly through Rallar and records received payloads
as `rallar.direct.ws.message` events.

HTTP request:

```json
{
  "kind": "http.request",
  "commandId": "http-health-1",
  "request": {
    "path": "/health",
    "method": "GET"
  },
  "response": {
    "body": "json",
    "maxBodyChars": 2000
  }
}
```

## Recipes

A recipe is an ordered list of commands:

```json
{
  "recipeId": "demo-recipe",
  "name": "Demo recipe",
  "continueOnFailure": false,
  "commands": [
    {
      "kind": "configure",
      "commandId": "configure-1",
      "config": {
        "runId": "demo-run",
        "agentId": "agent-1",
        "roomId": "demo-room"
      }
    },
    {
      "kind": "rtc.connect",
      "commandId": "rtc-connect-1",
      "connection": "aliceRtc",
      "roomId": "demo-room"
    },
    {
      "kind": "stats",
      "commandId": "stats-1"
    }
  ]
}
```

The local workbench can load and run recipe JSON directly. The manual workbench can also generate a recipe snippet from
manual actions.

## Replay And Idempotency

The runtime caches completed results by `commandId`. If the same command ID is received again, the runtime can return the
cached result instead of repeating the operation.

There is one important isolation rule: child commands inside a new `recipe.run`
are executed again even when they reuse the same child `commandId` values as a
previous recipe run. This keeps cancelled or failed recipes from poisoning a
later run with stale child results. Direct duplicate command execution still
uses `commandId` replay.

The control server also applies idempotency when enqueueing commands:

- same `commandId` and same payload returns the existing command
- same `commandId` and different payload is rejected

This matters for reconnects and server retries.

## Validation And Safety

Before commands execute:

- the browser control client validates protocol version, run ID, agent ID, command ID, and command shape
- the control server validates REST-enqueued command shape
- the control server can restrict allowed command kinds
- HTTP and WebSocket destinations can be restricted by host or origin
- request payload size can be capped
- run tokens can be required

Do not enable broad remote control against untrusted inputs without command allowlists, destination allowlists, tokens,
and TLS/origin policy.
