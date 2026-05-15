# UI User Manual

The Rallar Black Box UI is an operational test surface. It is not a landing page. The first screen is the workbench and
run state for the current browser agent.

## Startup Modes

Local workbench mode is the default:

```text
http://localhost:5176/
```

In this mode the app loads and runs a local sample recipe so the panels show useful state immediately.

The local UI does not require login. It uses demo defaults and the current simulated SPA executor. Login/auth values are
only needed when a future or configured real Rallar browser adapter targets an environment that requires authentication.

The header, bootstrap panel, configuration panel, and report snapshot show the active provider mode. If
`browser-rallar` is selected before the real adapter is implemented, commands fail explicitly instead of falling back to
simulated RTC loopback.

Control-agent mode configures the browser as a remote agent:

```text
http://localhost:5176/?mode=control&controlUrl=ws%3A%2F%2Flocalhost%3A5180%2Fcontrol&runId=demo-run&agentId=agent-1
```

Useful query parameters:

- `mode=control` or `mode=control-agent`: start in remote control mode
- `autoConnect=1`: connect to the control server after bootstrap
- `provider=simulated` or `provider=browser-rallar`: select simulated or real-provider execution mode
- `controlUrl`: WebSocket URL, for example `ws://localhost:5180/control`
- `controlToken`: optional run token
- `runId`: stable run identifier
- `agentId`: stable browser agent identifier
- `environment`: logical environment label
- `apiBaseUrl`: base URL used by HTTP commands with relative paths
- `actor`: actor identity
- `sessionId`: browser session/client identity
- `roomId`: Rallar group or room ID
- `transport`: `realtime`, `messages.rtc`, `ws`, or `http`
- `statsIntervalMs`: periodic control stats interval
- `reportUploadUrl`: optional REST endpoint for final reports

## Header

The header summarizes the current runtime:

- run state
- control connection state
- run ID and agent ID
- actor, session, room, and selected environment
- last action performed by the UI or bootstrap path

Use this first when a run looks idle. It tells you whether the app is waiting locally, running a command, connected to a
control server, or stuck in reconnect.

## Local Recipe Workbench

The local recipe workbench is for quick recipe testing without a server.

Use it to:

- select a built-in fixture
- edit recipe JSON
- load a recipe
- run the loaded recipe
- cancel a running recipe
- reset the workbench
- execute one raw command JSON payload

The built-in fixtures cover RTC smoke, WebSocket plus HTTP smoke, expected failure, and a cancellable long-running
recipe. These fixtures use the current SPA executor, so they validate the command and UI path rather than live Rallar
network traffic.

## Manual Rallar Workbench

The manual workbench is for fast testing without writing a full recipe.

Controls include:

- environment
- API base URL
- actor
- session/client ID
- group/room ID
- connection name
- target client
- multicast client list
- transport
- delivery mode
- timeout
- WebSocket URL
- topic, type ID, and topic ID
- JSON payload

Actions:

- `Configure`: set the runtime config for the current manual test
- `Join`: configure and connect in one operation
- `Connect`: open the selected RTC or WebSocket connection
- `Send`: send the JSON payload using direct, multicast, or broadcast metadata
- `Health`: collect current health
- `Close`: close active runtime connections
- `Reset`: clear runtime state for the next test

The command preview shows the exact `rallar-bb-test` command or command list that will be executed. The manual action
history links back to command results, and the recipe output can turn the manual session into a repeatable recipe.

## Received Data Inbox

The received-data inbox is derived from runtime `message` events.

Use it to answer:

- what payload arrived?
- which connection received it?
- which transport carried it?
- who was the sender?
- which topic was observed?
- which command produced the message event?

This panel is useful when comparing RTC and WebSocket behavior for the same JSON payload.

## RTC Diagnostics

The RTC diagnostics panel focuses on the sensitive connect path.

It derives:

- auth phase
- runtime bootstrap phase
- group join phase
- signaling phase
- peer discovery phase
- data-channel readiness phase
- first-payload phase
- expected versus observed clients
- missing, extra, and stale clients
- command and connect latency
- focused failure details
- copyable diagnostic bundle

Actions in this panel execute normal runtime commands:

- reconnect
- rejoin
- health
- close
- cleanup
- show bundle
- copy bundle

Use this panel before reading low-level events. It provides a compact view of whether connect reached the expected
stages and where it failed.

## Topology

The topology panel derives a graphology graph from runtime events and renders it with Sigma.js.

It shows:

- run, agent, actor, connection, room, session, and message/diagnostic nodes
- control, identity, connection, membership, route, and diagnostic edges
- active, degraded, and failed status
- filters for all, active, degraded, and failed graph elements
- summary counts for edges, rooms, sessions, routes, degraded elements, and failed elements
- a visible node list
- recent RTC and WebSocket route command links

Use this view when a failure involves group membership, session identity, route behavior, or degraded links.

## Control Client

The control panel connects the browser to a control server.

Fields:

- WebSocket URL
- run ID
- agent ID

Actions:

- connect
- disconnect

Stats:

- sent envelope count
- received envelope count
- reconnect attempt count
- last heartbeat time
- last socket or protocol error

After registration, commands can be posted to the control server and dispatched over the open WebSocket. Results and
events stream back to the server automatically.

## Bootstrap

The bootstrap panel shows how the app started:

- local workbench or control-agent mode
- config source
- auto-connect setting
- control URL
- run ID and agent ID

Use this when a headless browser starts with unexpected identity or control settings.

## Configuration

The configuration panel shows the effective runtime config:

- run ID
- agent ID
- environment
- API base URL
- actor
- session ID
- room ID
- transport
- control mode

Sensitive values should be redacted by the shared runtime redaction rules.

## Command Queue

The command queue shows loaded recipe commands and their current status:

- pending
- running
- completed
- failed
- cancelled

Click a command to inspect its details in the active command and history panels.

## Current Focus

The current focus panel shows the active command or selected completed result.

It includes:

- command ID
- command kind
- status
- elapsed time
- deadline and remaining time when available
- retry metadata
- raw command or result JSON

Use this panel when a command is stuck, slow, failed, or unexpectedly replayed.

## Completed Commands

The completed commands panel lists historical command results with status and duration.

Click a row to inspect the selected result in the current focus panel. Manual action history and topology route rows also
link to these command IDs.

## Event Stream

The event stream shows runtime events with filters for:

- event kind
- command ID
- connection
- actor
- transport
- topic text
- severity

Use event filtering when you need the lower-level evidence behind a diagnostic, message, stat, or result.

## Stats

The stats panel displays the latest runtime counters and Rallar health summary:

- command count
- event count
- failure count
- message count
- diagnostic count
- reconnect count
- peer count
- RTC lane health
- command latency summary
- last command
- last event time

## Failure Focus

The failure panel highlights the first recorded failure and shows the redacted error details. Start here when a recipe or
manual action ends in a failed state.

## Report

The report panel shows a redacted report snapshot built from runtime state:

- run/config summary
- latest stats
- command results
- events
- first failure

This is the payload shape intended for later durable ingestion and monitor-server analysis.
