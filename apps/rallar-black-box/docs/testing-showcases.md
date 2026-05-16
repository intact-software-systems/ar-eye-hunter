# Testing Showcases

This document describes how Rallar Black Box can be used from small manual checks to larger controlled runs. The default
SPA provider is simulated, so local examples validate orchestration, UI, diagnostics, reporting, and command shape. Use
`provider=browser-rallar` with real environment config when the same command path should exercise live Rallar.

## Small Scale: Local Visible Smoke

Goal: quickly verify the UI, runtime state, events, stats, and report output.

Steps:

1. Start the SPA with `npm run dev:rallar-black-box`.
2. Open `http://localhost:5176/`.
3. Let the default local recipe run.
4. Inspect the command queue and completed commands.
5. Open the event stream and filter by `message` or `diagnostic`.
6. Inspect stats, first failure, report, and topology.

Good signal:

- commands move from pending to completed
- selected result JSON is visible
- events are correlated to command IDs
- received data appears for message events
- topology shows run, agent, actor, connection, room, session, and route nodes

## Small Scale: Manual Direct Send

Goal: check the shape of a direct send before writing a recipe.

Steps:

1. Use the Manual Rallar panel.
2. Set actor, session, group, connection, and target client.
3. Select `realtime` or `messages.rtc`.
4. Select delivery mode `direct`.
5. Pick a payload preset or paste JSON.
6. Review the command preview.
7. Click `Join`, then `Send`.
8. Inspect completed commands, received data, event stream, and topology route links.

Good signal:

- connect and send commands have stable command IDs
- payload metadata contains the intended group and target
- received-data inbox shows the payload event
- topology contains a route edge

## Small Scale: RTC Versus WebSocket Payload Parity

Goal: compare how the same JSON payload is represented over RTC and WebSocket paths.

Steps:

1. Send a payload with transport `realtime`.
2. Switch transport to `ws` and use the same payload.
3. Compare command results.
4. Compare received-data inbox entries.
5. Filter the event stream by topic or command ID.

Good signal:

- command result status is comparable
- payload topic and body are easy to inspect in both paths
- differences are visible in command JSON and event payloads

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

## Medium Scale: One Control Server, One Browser Agent

Goal: exercise the remote command loop.

Start the control server:

```sh
npm run dev:rallar-black-box-control
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
npm run test:e2e:rallar-black-box
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
npm run test:e2e:rallar-black-box
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
npm run test:e2e:rallar-black-box
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
npm run dev:rallar-black-box-control
```

Start the SPA with real-provider defaults:

```sh
VITE_RALLAR_PROVIDER=browser-rallar \
VITE_RALLAR_API_BASE_URL=https://api.example.test \
VITE_RALLAR_ROOM_ID=room-to-join \
VITE_RALLAR_USERNAME=alice \
VITE_RALLAR_PASSWORD=secret \
npm run dev:rallar-black-box -- --host 127.0.0.1 --port 5176
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

## Large Scale: Planned Controlled Runs

The intended large-scale shape is:

```text
test orchestrator or black-box runner
  -> control server or durable control API
  -> many browser agents
  -> Rallar service
  -> event, stats, result, and report ingestion
  -> monitor/report analysis
```

This shape is partially implemented. Browser agents, control envelopes, result replay, stats, reports, and local
orchestration exist. Durable storage, monitor ingestion, and long-running seeded-random runs are still planned.

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

The current UI now has a panel or report surface for each of these areas. The remaining work is to connect those surfaces
to live Rallar traffic and durable backend state.
