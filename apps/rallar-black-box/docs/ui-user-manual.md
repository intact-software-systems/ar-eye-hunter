# UI User Manual

The Rallar Black Box UI is an operational test surface. It is not a landing page. In simulated mode the first screen is
the app shell for the current browser agent. In `browser-rallar` mode the first screen is the Rallar Server login gate
unless a browser auth session can be restored.

## Startup Modes

Local workbench mode is the default:

```text
http://localhost:5176/
```

In this mode the app loads and runs a local sample recipe so the panels show useful state immediately.

The local UI does not require login. It uses demo defaults and the simulated provider. Login/auth values are only needed
when `provider=browser-rallar` targets a real environment. After login, REST-capable commands use the stored access
token and client ID.

The header, bootstrap panel, configuration panel, and report snapshot show the active provider mode. `browser-rallar`
requires a real API base URL plus username/password or `restoreSession=true`; it does not fall back to simulated RTC
loopback.

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
- `tab`: `manual-rallar`, `topology`, `rtc-diagnostics`, `local-workbench`, `event-stream`, or `rallar-server`
- `rallarUsername` and `rallarPassword`: login credentials for `browser-rallar`
- `rallarRestoreSession=1`: restore an existing browser auth session for `browser-rallar`
- `rallarRegister=1`: register and log in before connecting when the target environment supports test-user creation
- `rallarLogoutOnClose=1`: log out during real-provider close/reset cleanup instead of only disconnecting
- `rallarLeaveRoomOnClose=0`: opt out of the default best-effort room leave during real-provider close/reset cleanup
- `statsIntervalMs`: periodic control stats interval
- `reportUploadUrl`: optional REST endpoint for final reports

## Header And Tabs

The header summarizes the current runtime:

- run state
- control connection state
- run ID and agent ID
- actor, session, room, and selected environment
- active command and first failure
- last action performed by the UI or bootstrap path

Use this first when a run looks idle. It tells you whether the app is waiting locally, running a command, connected to a
control server, or stuck in reconnect.

The top tabs split the workspace into:

- `Manual Rallar`
- `Topology`
- `RTC Diagnostics`
- `Local Workbench`
- `Event Stream`
- `Rallar Server`

The active tab is written to `?tab=...` and saved in browser storage. If you later open the app without a `tab`
parameter, it returns to the last selected tab. Tab panes stay mounted while hidden, so form edits, recipe text, selected
commands, topology filters, and event filters remain in place when moving between tabs.

The UI also persists selected command ID, Manual Rallar drafts, Event Stream filters, and Rallar Server request drafts
across reloads. Persisted drafts are sanitized first: Manual Rallar passwords are not stored, JSON editor drafts are
redacted by sensitive keys/known secret values, and invalid JSON editor drafts are dropped instead of being saved with
possible secrets.

## Local Recipe Workbench

The `Local Workbench` tab is for quick recipe testing without a server.

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

The `Manual Rallar` tab is for fast testing without writing a full recipe. It contains the manual controls, received
data inbox, and completed-command history.

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
- `Create and join group`: configure and connect in one operation; for real RTC with `browser-rallar`, this first
  creates the group through the authenticated Rallar Server API
- `Connect`: open the selected RTC or WebSocket connection
- `Send`: send the JSON payload using direct, multicast, or broadcast metadata
- `Health`: collect current health
- `Close`: close active runtime connections
- `Reset`: clear runtime state for the next test

The command preview shows the redacted `rallar-bb-test` command or command list that will be executed. The manual action
history links back to command results, and the recipe output can turn the manual session into a repeatable redacted
recipe.

## Received Data Inbox

The received-data inbox is in the `Manual Rallar` tab and is derived from runtime `message` events.

Use it to answer:

- what payload arrived?
- which connection received it?
- which transport carried it?
- who was the sender?
- which topic was observed?
- which command produced the message event?

This panel is useful when comparing RTC and WebSocket behavior for the same JSON payload.

## RTC Diagnostics

The `RTC Diagnostics` tab focuses on the sensitive connect path.

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

The `Topology` tab derives a graphology graph from runtime events and renders it with Sigma.js.

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

The control panel lives in the `Local Workbench` tab and connects the browser to a control server.

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

The bootstrap panel lives in the `Local Workbench` tab and shows how the app started:

- local workbench or control-agent mode
- config source
- auto-connect setting
- control URL
- run ID and agent ID

Use this when a headless browser starts with unexpected identity or control settings.

## Configuration

The configuration panel lives in the `Local Workbench` tab and shows the effective runtime config:

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

The command queue lives in the `Local Workbench` tab and shows loaded recipe commands and their current status:

- pending
- running
- completed
- failed
- cancelled

Click a command to inspect its details in the active command and history panels.

## Current Focus

The current focus panel lives in the `Event Stream` tab and shows the active command or selected completed result.

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

The completed commands panel lists historical command results with status and duration. It appears in the `Manual
Rallar` and `Event Stream` tabs.

Click a row to inspect the selected result in the current focus panel. Manual action history and topology route rows also
link to these command IDs.

## Event Stream

The `Event Stream` tab shows runtime events with filters for:

- event kind
- command ID
- connection
- actor
- transport
- topic text
- severity

Use event filtering when you need the lower-level evidence behind a diagnostic, message, stat, or result. Event filters
survive reloads, which makes it easier to keep a narrowed failure view while iterating on a reproduction.

## Rallar Server

The `Rallar Server` tab shows the current server-facing context and a REST request workbench.

- API base URL
- provider mode
- authenticated user and client ID
- session ID
- access-token presence with the token value redacted
- control connection state
- local or server-refreshed OpenAPI endpoint source

Request controls:

- endpoint preset
- API base URL
- method
- path
- timeout
- response body mode
- auth attachment
- query JSON
- headers JSON
- body JSON

Actions:

- `Send`: execute the request from the browser
- `Reset Preset`: restore the selected preset defaults
- `Refresh OpenAPI`: load endpoint rows from `/api/openapi.json`
- `Copy cURL`: copy a redacted cURL reproduction
- `Copy Command`: copy a redacted black-box `http.request` command

The response area shows status, duration, body kind, classified error, parsed JSON or raw text, response headers, and
the generated command. Response text, response URLs, command previews, and copied output are redacted for sensitive
keys, access tokens, bearer values, tickets, cookies, and known secret values from the active session. In
`browser-rallar` mode the tab refuses to send real-provider requests to the placeholder `https://api.example.invalid`
API base URL.

## Stats

The stats panel displays the latest runtime counters and Rallar health summary. It appears in the `RTC Diagnostics` and
`Event Stream` tabs.

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

The failure panel highlights the first recorded failure and shows the redacted error details. It appears in the `RTC
Diagnostics` and `Event Stream` tabs.

## Report

The report panel lives in the `Local Workbench` tab and shows a redacted report snapshot built from runtime state:

- run/config summary
- latest stats
- command results
- events
- first failure

This is the payload shape intended for later durable ingestion and monitor-server analysis.
