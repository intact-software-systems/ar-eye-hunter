# Testing Showcases

This document describes how Rallar Black Box can be used from small manual checks to larger controlled runs. The default
SPA provider is simulated, so local examples validate orchestration, UI, diagnostics, reporting, and command shape. Use
`provider=browser-rallar` with real environment config when the same command path should exercise live Rallar.
The blank URL and provider-only URLs open Recipe Console `Execute`; the other primary views are `Monitor`, `Analyze`,
`Tune`, `Fleet`, and `Advanced`.

## Small Scale: Local Visible Smoke

Goal: quickly verify the Recipe Console execution, monitoring, and evidence flow.

Steps:

1. Start the control server with `npm run dev:rallar:control`.
2. Start the SPA with `npm run dev:rallar`.
3. In a separate browser session, open a simulated control agent at
   `http://localhost:5176/?mode=control&autoConnect=1&controlUrl=ws%3A%2F%2Flocalhost%3A5180%2Fcontrol&runId=demo-run&agentId=agent-1`.
4. Open `http://localhost:5176/` as the operator.
5. In `Execute`, choose a seeded recipe and resolve its simulated target.
6. Create, stage, and start the run with the visible lifecycle controls.
7. Open `Monitor` to inspect progress, verdict, and correlated evidence.
8. Open `Analyze` to search or inspect the resulting bounded artifact evidence.

Good signal:

- the run moves through create, stage, start, and a terminal verdict
- participant and recipe progress is visible
- the first failure is prominent when the recipe is expected to fail
- event, result, diagnostic, and artifact evidence stays correlated to the run and command IDs

## Small Scale: Auth And WS Ticket Check

Goal: verify that a user can authenticate and acquire a WebSocket ticket without exposing secrets in the UI.

Steps:

1. Open the `Auth` tab.
2. Fill API base URL, username, and password.
3. Click `Login` or `Register and login`.
4. Click `Create WS ticket`.
5. Run `Bad credentials` or `Missing auth ticket` as a negative check.
6. Copy diagnostics or the auth recipe when the flow is useful.

Good signal:

- session state shows user, client, session, and expiry
- token and ticket values are shown only as redacted presence
- negative actions appear in the action log with expected status codes

## Small Scale: Group And Client State Evidence

Goal: verify group membership and client presence before testing delivery.

Steps:

1. Log in or restore a session.
2. Open the `Groups/Clients` tab.
3. Fill application, workspace, group, client/principal, instance, and session values.
4. Click `Create group`, `Join group`, and `Connect client presence` as needed.
5. Click `Refresh state`.
6. Inspect group rows, client rows, state events, and expected/observed client metrics.

Good signal:

- the group row has the expected group ID and member count
- the client row has the expected principal and active session
- state events prove the latest membership or presence transition
- expected/observed client metrics are consistent with RTC diagnostics

## Small Scale: REST Collection Assertion Flow

Goal: turn a useful REST sequence into a repeatable command-center check.

Steps:

1. Open the `Rallar Server` tab.
2. Select a REST collection template or paste `Collection JSON`.
3. Fill `Variables JSON` for application, workspace, group, client, and session values.
4. Click `Run Collection`.
5. Inspect each step's status and assertion chips.
6. Check extracted variables for values that should feed later steps.
7. Copy the collection or collection recipe when the sequence is ready to share.

Good signal:

- expected status assertions pass
- JSON-path body and header assertions pass
- extracted variables appear in `Variables JSON`
- the copied recipe contains `http.request` commands with assertion metadata

## Small Scale: Manual Direct Send

Goal: check the shape of a direct send before writing a recipe.

Steps:

1. Use the Manual Rallar panel.
2. Set actor, session, group, connection, and target client.
3. Select `realtime` or `messages.rtc`.
4. Select delivery mode `direct`.
5. Pick a payload preset or paste JSON.
6. Review the command preview.
7. Click `Create and join group` or `Connect`, then `Send`.
8. Inspect completed commands, received data, event stream, and topology route links.

Good signal:

- connect and send commands have stable command IDs
- payload metadata contains the intended group and target
- received-data inbox shows the payload event
- topology contains a route edge

## Small Scale: RTC Versus WebSocket Payload Parity

Goal: compare how the same JSON payload is represented over RTC and WebSocket paths.

Steps:

1. Use the `Groups/Clients` tab to create or confirm the group and client evidence when testing against a real server.
2. Open the `WebSocket` tab.
3. Select the parity payload preset or paste the JSON payload that should also be sent over RTC.
4. Click `Configure WS`, then `Create WS ticket` and `Open API WS` for authenticated API sockets.
5. Click `Send JSON` and inspect the WebSocket event rows.
6. Copy the WS/RTC recipe or switch to `Manual Rallar` and send the same payload with transport `realtime`.
7. Compare command results, received-data inbox entries, and event-stream rows by topic or command ID.

Good signal:

- command result status is comparable
- payload topic and body are easy to inspect in both paths
- differences are visible in command JSON and event payloads

## Small Scale: WebSocket Reconnect Investigation

Goal: make WS open, send, reconnect, close, and ticket evidence visible without searching raw events first.

Steps:

1. Open the `WebSocket` tab.
2. Fill API base URL, connection name, group, target client, and payload.
3. Click `Configure WS`.
4. Click `Create WS ticket`.
5. Click `Open API WS`.
6. Click `Send JSON`.
7. Click `Wait for message` when the scenario expects a response or routed inbound event.
8. Click `Reconnect` and then `Close` or `Cleanup`.
9. Copy diagnostics if close code, close reason, ticket expiry, or event sequence needs to become bug-report evidence.

Good signal:

- ready state and last open/close timestamps match the action sequence
- inbound, outbound, and error counts match the event rows
- close code and reason are visible after close
- copied diagnostics redact ticket-shaped values

## Small Scale: Connect Failure Investigation

Goal: make RTC connect failure evidence copyable.

Steps:

1. Run `Join` or `Connect`.
2. Open the RTC Diagnostics panel.
3. Inspect the connect-stage timeline.
4. Check expected, observed, missing, extra, and stale clients.
5. Use `Health`, `Reconnect`, `Rejoin`, or `Cleanup`.
6. Show or copy the diagnostic bundle.

Good signal:

- failed or degraded stages are highlighted
- the first useful failure is visible
- latency values are captured
- the bundle can become a recipe or bug report input

## Medium Scale: Scoped RTC Delivery Matrix

Goal: exercise direct, multicast, and broadcast delivery over both RTC transports with the same scoped Rallar context.

Steps:

1. Open the `Manual Rallar` tab.
2. Fill application ID, workspace ID, group, scope JSON, room ref JSON, and minimum snapshot version.
3. Fill target client and multicast clients.
4. Paste the JSON payload.
5. Click `Run Realtime Matrix`.
6. Click `Run Messages Matrix`.
7. Open `RTC Diagnostics`.
8. Review ready peers, active peers, missing peers, lane health, first-payload latency, and NACK state.
9. Copy the matrix recipe when the flow should become repeatable.

Good signal:

- direct, multicast, and broadcast commands are generated for both `realtime` and `messages.rtc`
- scoped fields are visible in command previews and copied recipes
- peer diagnostics show the intended targets
- lane health and first-payload timing are available without opening raw logs

## Medium Scale: RTC Negative Probes

Goal: capture repeatable recipes for common RTC failure modes.

Steps:

1. Configure Manual Rallar with the group, clients, scoped fields, and payload for the scenario.
2. Click `NACK Probe` to run a not-yet-in-sync check immediately.
3. Click `Copy Negative Recipe`.
4. Use the copied recipe as a starting point for missing-peer, stale-agent, duplicate-session, permission-denied,
   closed-transport, and not-yet-in-sync cases.
5. Open `RTC Diagnostics` and copy the bundle when the provider returns useful failure evidence.

Good signal:

- the copied recipe keeps the same scoped RTC context
- negative cases are named in command metadata
- NACK codes appear in RTC Diagnostics
- the failure bundle has enough redacted context to reproduce the run

## Medium Scale: Flow Builder Composition

Goal: turn a manual plan into a runnable SPA recipe and a runner scenario.

Steps:

1. Open the `Flow Builder` tab.
2. Select `Auth REST WS RTC`.
3. Edit variables for API URL, group, application, workspace, target client, and payload.
4. Add or edit steps for REST, WS, RTC, wait, and cleanup.
5. Review the SPA recipe preview and runner scenario preview.
6. Click `Run Flow`.
7. Inspect step status rows and command links.
8. Copy the SPA recipe or runner scenario when the flow should move to automation.

Good signal:

- placeholders resolve consistently in the preview
- step status maps back to command IDs
- the same intent can be run in the SPA or exported for black-box-runner work
- expected result and extraction metadata stay next to the step that owns it

## Medium Scale: One Control Server, One Browser Agent

Goal: exercise the remote command loop.

Start the control server:

```sh
npm run dev:rallar:control
```

Start the SPA and open it as an agent:

```text
http://localhost:5176/?mode=control&autoConnect=1&controlUrl=ws%3A%2F%2Flocalhost%3A5180%2Fcontrol&runId=demo-run&agentId=agent-1
```

Post a command:

```sh
curl -X POST http://localhost:5180/runs/demo-run/agents/agent-1/commands \
  -H 'Content-Type: application/json' \
  -d '{
    "commandId": "stats-1",
    "command": {
      "kind": "stats",
      "commandId": "stats-1"
    }
  }'
```

Inspect the run:

```sh
curl http://localhost:5180/runs/demo-run
```

Good signal:

- browser registers as `agent-1`
- command is accepted with HTTP 202
- result is stored in the run snapshot
- the SPA shows the command result
- stats and report envelopes are collected

## Medium Scale: Multiple Browser Agents

Goal: model group membership and multi-client behavior.

Steps:

1. Start the control server.
2. Open multiple browser windows or headless browser pages.
3. Give each page the same `runId` and a different `agentId`.
4. Give each page a distinct actor and session ID.
5. Enqueue configure, connect, send, health, and stats commands per agent.
6. Compare run snapshots and UI reports.
7. Open the `Run Manager` tab to select the agents as a group, queue Health/Stats/Browser Reset presets, and inspect
   bounded commands/results/events without leaving the SPA.
8. Use `Load Artifact` and the copy actions to capture a redacted bundle, events JSONL, results JSONL, or failure bundle
   for issue reports.

Suggested identity pattern:

```text
runId=group-smoke-001
agentId=alice-agent, actor=alice, sessionId=alice-session
agentId=bob-agent, actor=bob, sessionId=bob-session
agentId=charlie-agent, actor=charlie, sessionId=charlie-session
```

Good signal:

- each agent has independent command history
- command IDs are unique per agent or intentionally shared only when idempotency is desired
- received events can be grouped by session and transport
- topology makes membership or route problems easier to spot

In simulated mode this validates orchestration and diagnostics. With `provider=browser-rallar` and real environment
config, the two-agent smoke validates actual cross-browser delivery.

## CI Smoke: Browser Agent Registration

Goal: ensure the SPA still boots, registers with the control server, receives a command, and returns a result.

Run:

```sh
npm run test:rallar
```

The Playwright smoke starts the SPA and control server, opens the SPA in control-agent mode, enqueues a `stats` command,
and verifies the result is collected by the control server and visible in the app.

## Live Smoke: Browser Rallar Connect And Send

Goal: prove one SPA agent can authenticate, connect to Rallar, join a room, and execute a realtime send command.

Run with a real environment:

```sh
VITE_RALLAR_PROVIDER=browser-rallar \
VITE_RALLAR_API_BASE_URL=https://api.example.test \
VITE_RALLAR_ROOM_ID=room-to-join \
VITE_RALLAR_USERNAME=alice \
VITE_RALLAR_PASSWORD=secret \
VITE_RALLAR_LOGOUT_ON_CLOSE=true \
npm run test:rallar
```

Optional `VITE_RALLAR_REAL_PEER_IDS` can provide comma-separated peer IDs for direct or multicast realtime sends. Without
peers, the smoke still verifies real connect and a safe no-peer realtime send path. The test is skipped automatically
when the real environment variables are absent.

## Live Smoke: Two-agent Delivery

Goal: prove two browser agents can join the same Rallar room and exchange payloads over realtime and `messages.rtc`.

Run with one shared login in isolated browser contexts:

```sh
VITE_RALLAR_API_BASE_URL=https://api.example.test \
VITE_RALLAR_ROOM_ID=room-to-join \
VITE_RALLAR_USERNAME=alice \
VITE_RALLAR_PASSWORD=secret \
VITE_RALLAR_TYPE_ID=manual.type \
VITE_RALLAR_TOPIC_ID=manual.topic \
npm run test:rallar
```

For separate agent credentials, use `VITE_RALLAR_AGENT_A_USERNAME`, `VITE_RALLAR_AGENT_A_PASSWORD`,
`VITE_RALLAR_AGENT_B_USERNAME`, and `VITE_RALLAR_AGENT_B_PASSWORD`. Restored-session mode is also supported with
per-agent `VITE_RALLAR_AGENT_A_TOKEN`, `VITE_RALLAR_AGENT_A_CLIENT_ID`, `VITE_RALLAR_AGENT_A_SESSION_ID`,
`VITE_RALLAR_AGENT_A_USERNAME`, and equivalent agent B values.

The two-agent smoke asserts command results, received-data inbox payloads, control-server message events, stats, final
reports, close/reset cleanup commands, and absence of simulated `rallar.bb.fake.*` topics.

Cleanup options:

- `VITE_RALLAR_LOGOUT_ON_CLOSE=true`: log out during real-provider close/reset cleanup
- `VITE_RALLAR_LEAVE_ROOM_ON_CLOSE=false`: skip the default best-effort room leave during cleanup
- `VITE_RALLAR_REGISTER=true`: register and log in before connecting when the test environment supports disposable users

## Live Baseline: Three-browser RTC Matrix

Goal: prove three real browser agents can join one isolated group and exchange real JSON through direct, multicast, and
broadcast delivery over both RTC transports.

Run with a provisioned environment:

```sh
RALLAR_BLACK_BOX_FULL_STACK=1 \
RALLAR_BLACK_BOX_LIVE_RTC_MATRIX=1 \
VITE_RALLAR_API_BASE_URL=http://localhost:18081 \
VITE_RALLAR_SPA_BASE_URL=http://localhost:5178 \
VITE_RALLAR_ROOM_ID=bb-live-room \
VITE_RALLAR_AGENT_A_USERNAME=alice \
VITE_RALLAR_AGENT_A_PASSWORD=secret \
VITE_RALLAR_AGENT_B_USERNAME=bob \
VITE_RALLAR_AGENT_B_PASSWORD=secret \
VITE_RALLAR_AGENT_C_USERNAME=charlie \
VITE_RALLAR_AGENT_C_PASSWORD=secret \
npm run test:rallar:full-stack:postgres:live-rtc-3
```

Good signal:

- the test creates a unique group derived from `VITE_RALLAR_ROOM_ID`
- all three agents join through authenticated REST commands
- realtime direct, multicast, and broadcast payloads reach the expected browsers
- `messages.rtc` direct, multicast, and broadcast payloads reach the expected browsers
- the not-yet-in-sync probe records NACK or min-snapshot evidence
- stale send after close fails visibly
- the control-server artifact bundle contains report and event evidence
- no `rallar.bb.fake.*` topics appear in the run

For exhaustive live coverage, use:

```sh
npm run test:rallar:full-stack:postgres:live-rtc-3:all
```

That variant covers every sender/receiver direct pair, every sender multicast, and every sender broadcast for the three
browser agents across both RTC transports. It also exercises REST group readback, authenticated API WebSocket
open/send/close from all three agents, unexpected-delivery detection, stale-send failure, reconnect-after-stale-agent,
and artifact validation.

When auth, room join, send permission, stale session, duplicate session, or cleanup failures occur, inspect the RTC
Diagnostics panel and copy its bundle. The bundle includes provider mode, environment, API base URL, actor/session/room,
transport, auth-state flags, command IDs, connect stages, failure source, recent results, and recent real-provider
events with sensitive fields redacted by the runtime redaction rules.

## Provider Parity: SPA Recipe And Runner

Goal: run the same command intent through the visible SPA and the black-box runner, then compare shared result semantics.

In the SPA, select the `Provider Parity` recipe fixture. It covers configure, RTC connect, direct send, multicast
metadata, broadcast metadata, health, close, and reset. In simulated mode it validates UI/report behavior without a
backend. With `provider=browser-rallar`, the same recipe uses the real browser Rallar provider.

Start the control server:

```sh
npm run dev:rallar:control
```

Start the SPA with real-provider defaults:

```sh
VITE_RALLAR_PROVIDER=browser-rallar \
VITE_RALLAR_API_BASE_URL=https://api.example.test \
VITE_RALLAR_ROOM_ID=room-to-join \
VITE_RALLAR_USERNAME=alice \
VITE_RALLAR_PASSWORD=secret \
npm run dev:rallar -- --host 127.0.0.1 --port 5176
```

Open it as a remote provider agent:

```text
http://localhost:5176/?mode=control&autoConnect=1&provider=browser-rallar&controlUrl=ws%3A%2F%2Flocalhost%3A5180%2Fcontrol&runId=parity-run&agentId=agent-alice&actor=alice&roomId=room-to-join&transport=realtime
```

Test helpers can convert the same parity recipe to runner interactions:

```ts
import { executeBlackBox } from './packages/shared-test/black-box-runner/execute-black-box.ts';
import {
  createRallarBlackBoxProviderParityRecipe,
  toRallarBlackBoxRunnerParityInteractions,
} from './packages/shared-test/rallar-bb-test/mod.ts';

const recipe = createRallarBlackBoxProviderParityRecipe({ providerMode: 'browser-rallar' });
const { interactions } = toRallarBlackBoxRunnerParityInteractions(recipe, {
  provider: 'rallar-remote-browser',
});

const report = await executeBlackBox(interactions, 0, {
  rallarRemoteBrowser: {
    controlBaseUrl: 'http://localhost:5180',
    runId: 'parity-run',
    agentId: 'agent-alice',
  },
});
```

Good signal:

- converted runner commands preserve the same connect, send, close, transport, room, and parity metadata as the SPA
  recipe
- direct send has a received-message assertion when an expected connection is configured
- multicast and broadcast commands keep target and delivery-mode metadata for report comparison
- runner-only remote fields, browser health, and timing fields are marked as provider-specific before comparison

## Shared-test Catalog And Artifact Import

Goal: discover runner recipes from the command center and inspect generated artifacts without re-running the scenario
from the browser.

Steps:

1. Open `Shared Test` from Recipe Console `Advanced`, or use
   `/?experience=legacy&workspace=black-box-runner&tab=shared-test`.
2. Filter the recipe catalog by provider, profile, or text.
3. Select a shared-test recipe and copy the root matrix or direct scenario command.
4. Run the command from local tooling when needed.
5. Import the generated artifact bundle files in the Artifact Import panel.
6. Inspect imported summary, event stream, RTC diagnostics, failure focus, and replay recipe.

Good signal:

- catalog entries show provider mode, live support, prerequisites, and expected result
- commands are copyable but not executed silently by the browser
- invalid artifact bundles show actionable file/path validation errors
- valid bundles show runner events, RTC diagnostics, failures, and replay data with redaction placeholders preserved

## Large Scale: Runner-backed Controlled Runs

The intended large-scale shape is still:

```text
test orchestrator or black-box runner
  -> control server or durable control API
  -> many browser agents
  -> Rallar service
  -> event, stats, result, and report ingestion
  -> monitor/report analysis
```

This shape is implemented across two layers. The SPA and control server provide browser agents, control envelopes,
result replay, stats, reports, local orchestration, bounded Event Stream windows, topology search/node limits, and
deterministic route summaries. Recipe Console adds bounded artifact search, cross-run comparison, History filters,
preview-first retention cleanup, and accessible deterministic windows for large run and artifact collections. The
shared-test runner provides deterministic same-connection soak, seeded traffic replay, bounded parallel groups,
redacted artifact bundles, and gated live browser/remote-browser recipes for those patterns. Control-server snapshot
persistence and the three-browser live RTC baseline exist for local runs. External monitor-server ingestion and
production-grade durable artifact storage remain separate work.

Useful runner commands:

```sh
npm run test:shared-black-box:matrix:deterministic
npm run test:shared-black-box:matrix:live:soak
npm run test:shared-black-box:matrix:live:traffic
npm run test:shared-black-box:matrix:live:parallel
```

The live commands are skip-safe unless the required services and credentials are configured. Strict live baseline
capture should happen in a provisioned Rallar environment.

For large runs, the important design rules are:

- use stable run IDs and agent IDs
- require run tokens
- restrict allowed command kinds
- restrict HTTP and WebSocket destinations
- keep command IDs deterministic
- emit periodic stats
- upload or retain final reports
- checkpoint long-running runs
- make cleanup commands explicit between scenarios

## Testing Areas To Prioritize

Useful Rallar testing areas:

- group membership correctness: expected versus observed clients
- RTC versus WebSocket behavior parity for the same payloads
- reconnect, rejoin, and stale-session cases
- direct, multicast, and broadcast delivery semantics
- connect latency and first-payload latency
- auth and permission negative cases
- cleanup isolation between runs
- copyable failure diagnostics that can become repeatable recipes

The current UI now has a panel or report surface for each of these areas, and shared-test has recipe/artifact coverage
for many of the long-running and generated-traffic patterns. The remaining command-center work is to harden live
negative fixtures for permission/expiry/CORS behavior, add fuller matrix/run browsing, and connect run output to
durable backend state.
