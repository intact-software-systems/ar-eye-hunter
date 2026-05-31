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
- `tab`: `auth`, `manual-rallar`, `rooms-clients`, `websocket`, `topology`, `rtc-diagnostics`, `local-workbench`,
  `run-manager`, `event-stream`, `rallar-server`, `flow-builder`, or `shared-test`
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
- signaling WebSocket status for browser-rallar RTC work
- RTC connection status derived from Rallar browser status/lifecycle events
- active command and first failure
- last action performed by the UI or bootstrap path

Use this first when a run looks idle. It tells you whether the app is waiting locally, running a command, connected to a
control server, or stuck in reconnect.

The top tabs split the workspace into:

- `Auth`
- `Manual Rallar`
- `Groups/Clients`
- `WebSocket`
- `Topology`
- `RTC Diagnostics`
- `Local Workbench`
- `Run Manager`
- `Event Stream`
- `Rallar Server`
- `Flow Builder`
- `Shared Test`

The active tab is written to `?tab=...` and saved in browser storage. If you later open the app without a `tab`
parameter, it returns to the last selected tab. Tab panes stay mounted while hidden, so form edits, recipe text, selected
commands, topology filters, and event filters remain in place when moving between tabs.

Above the tabs, the `Global Context` bar holds the common values used by the command-center panels:

- API base URL
- application ID
- workspace ID
- room/group ID
- client ID
- session ID

When a user logs in, the client ID and session ID are populated from the authenticated browser session. Editing the
global values updates the defaults used by Manual Rallar, Groups/Clients, WebSocket, RTC Diagnostics, Rallar Server, and
Flow Builder without changing payloads, timeouts, or endpoint-specific fields. `Use login/context` resets the global
values back to the current bootstrap/login context.

The `Rallar Browser Trace` strip sits below Global Context. It shows the signaling WebSocket status, RTC status, active
group, peer counts, and newest events whose source topic is `rallar.browser.*`. These events are emitted by the
browser-side Rallar runtime and then bridged into the command-center event store. Use `Rallar Trace` for expanded
Rallar browser/direct/server events with full redacted payloads and complete failure messages. Use `Event Stream` for
the generic event table and filters across every command-center event.

Between Global Context and the trace strip, the `Workspace Mode` switch separates direct live Rallar work from
black-box-runner work:

- `Rallar`: Quick Test, Auth, Groups/Clients, WebSocket, RTC/Realtimes, Topology, RTC Diagnostics, Rallar Data, Media,
  Rallar Server, Rallar Trace, and Event Stream. These tabs execute live operations through the browser Rallar facade or
  Rallar Server directly; they do not execute black-box-runner commands.
- `Rallar black-box-runner`: Shared Test, Manual Rallar, Local Workbench, Flow Builder, Run Manager, and Event Stream.
  These tabs work with recipes, command execution, control runs, or runner artifacts. The local sample replay control
  is shown only in this workspace.

The active mode is stored in the `workspace` query parameter. Existing `tab` deep links still work; opening a
runner-owned tab such as `shared-test` or `run-manager` automatically selects the black-box-runner workspace.

In `Rallar` mode, the `Direct Rallar Operations` panel establishes the direct-operation boundary. Its `Check Direct
Rallar` action calls the browser Rallar facade directly, applies the current Global Context defaults, starts/connects
Rallar, and emits `rallar.direct.*` diagnostics into the trace and event stream. If the app is running with the
simulated provider, the panel shows `real backend required` and does not fall back to fake data.

The default Rallar tab is `Quick Test`. It is the fastest path for real WS group traffic with two browser sessions:
create or join the group, subscribe the receiving browser, send JSON from either browser, and inspect received messages
in the same tab.

The UI also persists selected command ID, Manual Rallar drafts, Event Stream filters, and Rallar Server request drafts
across reloads. Persisted drafts are sanitized first: Manual Rallar passwords are not stored, JSON editor drafts are
redacted by sensitive keys/known secret values, and invalid JSON editor drafts are dropped instead of being saved with
possible secrets.

## Quick Test

The `Quick Test` tab is a guided Rallar-mode screen for real WS group messaging. It uses the current Global Context
values for API base URL, application, workspace, and group, plus the logged-in browser session.

The top summary shows provider mode, API, user, session, group, signaling WS status, subscription status, receive count,
wait status, and last direct action result. The route preview shows the active destination group, type/topic selector,
context, and whether this browser is subscribed.

Controls include:

- `Create and join group`: create a Rallar Server group using the current Group text as both group ID and display name,
  join it, and keep that value in Global Context.
- `Join group`: join the current Group ID.
- `Subscribe WS`: register `rallar.messages.ws.onMessage(...)`, connect signaling if needed, and join the current group.
- `Unsubscribe WS`: remove the active receive listener.
- `Send WS JSON`: send the payload editor JSON to the group through `rallar.messages.ws.send(...)`.
- `Wait for receive`: wait for one new received message in this browser.
- `Copy diagnostics`: copy redacted context, subscription, last result, error, wait, and recent receive details.

With two logged-in browsers, set the same Group/type/topic in both. Subscribe the receiving browser first, then send from
the other browser. Received payloads appear under `Received Messages` with sender, group, type, topic, context, resource,
and payload. Rallar Server WS tickets are single-use; the browser Rallar facade requests a fresh ticket whenever it opens
or reconnects the signaling socket.

## Auth Command Center

The `Auth` tab is for manual auth/session testing against Rallar Server.
It shows username, client ID, session ID, access-token presence, session expiry, session TTL, WS-ticket presence,
ticket expiry, and ticket TTL. Use separate browser contexts for Alice, Bob, and Charlie so each browser owns a distinct
`auth.session`; REST, WS, RTC, and Rallar Data actions should use the matching Global Context session.

Controls:

- API base URL
- username
- password

Actions:

- `Login`: authenticate and store the browser session
- `Register and login`: create a test user when the target server allows it, then authenticate
- `Restore session`: reload a valid browser auth session from local storage
- `Logout`: call the browser Rallar logout path and close active runtime connections
- `Clear local session`: remove the browser session without calling the server
- `Create WS ticket`: call `/api/auth/ws-ticket` with the active access token
- `Bad credentials`: send an intentional negative login request
- `Missing auth ticket`: request a WS ticket without attaching auth
- `Copy diagnostics`: copy redacted session, ticket, and action-log state
- `Copy auth recipe`: copy a JSON recipe snippet for login and WS-ticket checks

The panel shows provider mode, user, client ID, session ID, token presence, session expiry, WS-ticket presence, and
ticket expiry. Token, ticket, and password values are redacted in visible output.

## Groups/Clients

The `Groups/Clients` tab is for state evidence around groups, clients, sessions, and presence.

Variables:

- API base URL
- application ID
- workspace ID
- group ID
- principal/client ID
- client instance ID
- session ID
- timeout

Actions are grouped into `Groups` and `Clients`. Group actions include Rallar facade refresh/create/join/leave buttons
plus REST buttons for list, create, read, join, leave, group presence, and group events. Client actions include REST
buttons for list, client session connect/heartbeat/disconnect, and client events. `Refresh state` and `Copy state recipe`
remain as shared utility actions.

The latest operation is shown in a request-style status strip with target, status, duration, and the most useful message.
Use that strip for immediate success/failure feedback, then use the recent action list and state tables for historical
evidence.

The tab renders group rows, client rows, state event rows, recent REST actions, and expected/observed/missing client
metrics from RTC diagnostics. Use this tab when you need server-side evidence that a group, membership row, client
session, or presence record exists before testing WS or RTC delivery.

The visible state tables can be filtered to show only groups with at least one member and only clients that are online
or have active sessions. These filters are local UI filters; the REST calls still retrieve the normal server result.
Groups can be sorted by recently active, mutated newest, created newest, online members, member count, name/ID, or
status. Clients can be sorted by online first, recently active, mutated newest, created newest, active session count,
name/ID, or status.

The direct room buttons call the browser Rallar facade for refresh, create, join, and leave. The REST buttons remain the
server evidence path for group/client/session/presence/event endpoints. The assertion metrics show whether the current
client/session appears as a member and whether an expected other browser is visible before you send WS or RTC messages.

## WebSocket Command Center

The `WebSocket` tab is for focused WS testing against Rallar directly. App-level WS group/all sends call
`rallar.messages.ws.send(...)`, and subscriptions call `rallar.messages.ws.onMessage(...)`; they do not execute
black-box-runner `ws.send` commands or use the SPA `browser-rallar-runtime.ts` adapter. Raw `Open`/`Open API WS`
sockets are native browser WebSocket diagnostics for ticket and socket checks; use black-box-runner recipes when those
raw socket checks need repeatable command execution.

Controls include:

- API base URL
- connection name
- application and workspace
- group ID for room-scoped messages
- WS scope: `room`, `all`, or `world`
- type ID, topic ID, context ID, and optional resource ID
- WebSocket URL
- timeout
- payload preset
- JSON payload

The payload presets set both payload and routing fields:

- `Ping - all WS subscribers`: uses `scope = all` and ignores the Group field.
- `Group Message - current group`: uses `scope = room` and sends to the configured Group.
- `Compare WS vs RTC - current group`: uses `scope = room` with comparison type/topic fields for checking WS and RTC
  delivery against the same group.

The default preset is `Group Message - current group`, so the WebSocket tab starts from the joined/global group instead
of broadcasting to all subscribers. `Ping - all WS subscribers` is still available when you intentionally want an
all-scope liveness probe.

The route preview below the payload editor shows the exact destination, selector, context, and transport before send.
The latest-operation status strip shows target, status, duration, and failure text for sends, subscribes, waits, ticket
creation, and raw socket actions. The live status row makes the current app-level WS subscription explicit: subscribed
yes/no, subscribed group, selector, subscribed-since time, signaling WS status, and raw WS status. The `Received WS
Messages` panel shows the same listening state plus received message count and latest payloads. A browser must be
`listening` before it can display app-level Rallar WS messages from another browser.

Actions are split into two groups. `Rallar WS Messages` contains the app-message actions that call
`rallar.messages.ws.*` and `rallar.ws.waitForOpen(...)`. `Raw WebSocket Diagnostics` contains ticket and socket-level
checks such as opening the API WebSocket URL or testing a missing ticket. API-v1 WS tickets are consumed on successful
socket upgrade, so every raw `Open` should use a fresh ticket.

For a group message, set `WS Scope` to `room`, set `Group` to the same group joined by the browsers, and use the same
`Type ID` and `Topic ID` on every sender and receiver. Groups joined from Quick Test, Manual Rallar actions, or
Groups/Clients create/join actions are promoted into Global Context, and the WebSocket tab follows that value while its
group field has not been intentionally changed. Changing `Group` also updates `Context ID` while it still matches the
previous default, so the normal group path is `Group = my-group` and `Context ID = my-group`.

To see received Rallar WebSocket messages on a browser client, open the `WebSocket` tab in that browser and click
`Subscribe WS` before another browser sends. Subscribe registers `rallar.messages.ws.onMessage(...)` for the selected
type/topic, connects Rallar signaling if needed, and joins the selected group for room-scoped subscriptions. The receive
panel moves from `not listening` to `listening` only after the browser has a real app-level WS subscription. Received
app messages appear as `rallar.direct.ws.message` rows in the WebSocket event list plus the dedicated `Received WS
Messages` panel. `Wait for message` watches those rows and the inbound counter.

Actions:

- `Configure WS`: update runtime config for WS testing
- `Create WS ticket`: request `/api/auth/ws-ticket` with the logged-in browser session
- `Open`: execute the current `ws.open` command
- `Open API WS`: open the API-derived URL that uses `{auth.sessionId}` and `{auth.wsTicket}` placeholders
- `Send JSON`: execute `ws.send` with the current payload; in `browser-rallar` this sends through Rallar app-level WS
- `Subscribe WS`: subscribe the current browser to Rallar app-level WS messages for the selected type/topic, ensure
  signaling is connected, and join the selected group for room scope
- `Unsubscribe WS`: remove the active app-level WS subscription
- `Wait for message`: wait for a new inbound WS message event
- `Reconnect`: close and reopen the current WS connection
- `Close`: close the WS connection
- `Cleanup`: close WS and runtime connections for the current tab flow
- `Missing ticket open`: run a negative open against the API WS URL without a usable ticket
- `Copy diagnostics`: copy redacted WS status and recent event evidence
- `Copy WS recipe`: copy a repeatable configure/open/send/close recipe
- `Copy WS/RTC recipe`: copy a parity recipe that sends the same payload over WS and RTC

The tab shows provider mode, raw WS state, Rallar signaling WS state, group, selector, subscription, inbound/outbound/
error counts, wait state, ticket presence and expiry, last open/close timestamps, close code, close reason, and recent
WS events. Payloads and ticket-shaped values are redacted before display or copy.

## RTC/Realtimes

The `RTC/Realtimes` tab is for direct browser Rallar RTC work. It can subscribe to realtime JSON lanes, subscribe to
typed `messages.rtc` messages, send realtime JSON, send `messages.rtc` payloads with reliability/ack/ownership and
min-snapshot controls, wait for a room lane, refresh lane health, and copy an RTC runner recipe.

For interactive testing, `messages.rtc` defaults to `best-effort` so an open data channel sends immediately. Choose
`at-least-once` when the test specifically needs durable local-outbox behavior. The tab records
`rallar.direct.rtc_realtime.phase` timing events for facade load, configure, start, join, and send/subscribe actions.
After the browser session is already active in the selected group, later sends skip the repeated join call.

The latest-operation status strip shows target, status, duration, and failure text for subscribe/send/wait/health
actions. The live subscription row shows whether realtime lane and `messages.rtc` listeners are active, which group/lane
or selector they use, and when the newest subscription was installed. Received RTC/Realtimes payloads stay visible in
the tab until cleared by page reload or navigation cleanup.

## Rallar Data

The `Rallar Data` tab exposes scoped browser stores. Select app, principal, session, or custom scope; choose durability
and hydration; then run store lifecycle, read/write/update, compare-and-set, delete, export, usage estimate, and scope
cleanup operations. Results and change events are rendered with the normal UI redaction.

## Media

The optional `Media` tab exposes local stream attach, audio/video toggles, stop controls, media policy JSON, remote
stream subscription, and diagnostics. It is separate from Quick Test so media permissions and device errors do not
clutter message/data testing.

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

The shared-test runner has a larger recipe catalog for HTTP, WS, RTC, soak, seeded traffic, bounded parallel groups,
and artifact generation. Use the `Shared Test` tab to browse selected shared-test entries, copy runner commands, and
import runner artifact bundles.

## Manual Rallar Workbench

The `Manual Rallar` tab lives in `Rallar black-box-runner` mode because it is a command/recipe scratchpad. It remains
useful for older black-box-runner flows and repeatable command generation, but direct live Rallar work should use
`Quick Test`, `WebSocket`, `RTC/Realtimes`, `Rallar Data`, and `Media`. It contains the manual controls, received data
inbox, and completed-command history.

Controls include:

- environment
- API base URL
- application ID
- workspace ID
- actor
- session/client ID
- group/room ID
- scope JSON
- room ref JSON
- minimum snapshot version
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
- `Run Realtime Matrix`: configure, connect, then direct, multicast, and broadcast over `realtime`
- `Run Messages Matrix`: configure, connect, then direct, multicast, and broadcast over `messages.rtc`
- `NACK Probe`: send a not-yet-in-sync probe with a high minimum snapshot version
- `Copy Matrix Recipe`: copy a realtime plus `messages.rtc` delivery matrix recipe
- `Copy Negative Recipe`: copy missing-peer, stale-agent, duplicate-session, permission-denied, closed-transport, and
  not-yet-in-sync/NACK probes

For real RTC sends, `Send` is expected to fail when the browser has no routable RTC peers. A one-browser test can
create and join a group successfully, but direct, multicast, and broadcast RTC delivery still need another browser
session in the group with an open route. The UI reports those cases as no-peer or no-route send failures.

The command preview shows the redacted `rallar-bb-test` command or command list that will be executed. The manual action
history links back to command results, and the recipe output can turn the manual session into a repeatable redacted
recipe. Scoped RTC fields are passed through to `rtc.connect` and `rtc.send` so real-provider tests can exercise the
same application, workspace, scope, room reference, and snapshot-version constraints that Rallar Server uses.

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
- ready peer IDs
- active peer IDs
- missing, extra, and stale clients
- lane health
- NACK codes
- command and connect latency
- RTC event/message/failure/phase-duration time-series graphs
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
- search across node id, label, kind, and status
- node limit controls for 18, 50, 100, or 200 visible node rows
- summary counts for edges, rooms, sessions, routes, degraded elements, failed elements, route commands, RTC routes, WS
  routes, and route failures
- a visible node list that reports how many matching nodes are currently shown
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

## Run Manager

The `Run Manager` tab is the visible control-server orchestrator for multi-agent runs.

Fields:

- Control HTTP base URL
- optional admin/run token
- selected run
- command JSON

Actions:

- refresh bounded run snapshots
- select a run
- select one or more agents as an ad hoc group
- apply Health, Stats, or Browser Reset command presets
- enqueue the command to all selected agents
- reset the selected run snapshot
- delete the selected run
- load and validate a redacted run artifact bundle
- copy artifact bundle files, events JSONL, results JSONL, and failure bundle JSON

It shows:

- run, agent, connected, queued, completed, result, event, and report counts
- known runs sorted by update time
- connected/offline agent state, heartbeat time, queue count, and completed count
- recent queued/dispatched/completed commands
- recent results and events
- artifact summary and imported failure/result preview

`Reset Run` clears the control-server in-memory snapshot for that run while keeping known agents and tokens. `Delete Run`
removes the in-memory run and closes connected control sockets for that run. Browser-side cleanup still requires
enqueueing a `reset` command to the selected agents.

The control server can export a shared-test-compatible artifact bundle from a run. The Run Manager validates that bundle
with the same parser used by the `Shared Test` artifact import panel, so the copied files can be attached to issues or
loaded back into the SPA.

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
- visible event window size

Use the `Window` control to keep the newest 40, 100, 250, or 500 matching events visible. When older matching events
are hidden, the tab shows a status line with the hidden count. Use event filtering when you need the lower-level
evidence behind a diagnostic, message, stat, or result. Event filters survive reloads, which makes it easier to keep a
narrowed failure view while iterating on a reproduction.

Real-provider browser events from Rallar use `rallar.browser.*` topics. For RTC connect investigations, filter the topic
to `rallar.browser` and compare it with the summarized stages in `RTC Diagnostics`.

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

The REST Collection area turns repeated REST checks into a small runnable flow.

Collection controls:

- `Collection Template`: start from group membership, client presence, or negative auth/state templates
- `Variables JSON`: named values used by placeholders such as `{{groupId}}` or `${principalId}`
- `Collection JSON`: editable steps with request, expected status/body/header assertions, and extraction rules
- `Add Current Request`: append the current single-request workbench request as a collection step
- `Run Collection`: execute steps in order, stopping at the first failed assertion
- `Copy Collection`: copy the redacted collection plus current variables
- `Copy Collection Recipe`: copy a black-box `http.request` recipe with assertion/extraction metadata

For self-service group membership calls, the `principalId` path segment must be the authenticated client ID shown in the
Rallar Server context. A logged-in Alice session can join
`/groups/<groupId>/members/<alice-client-id>` with body `{"status":"active"}`. Using another principal ID is rejected,
and sending the join request without the body produces a server `400 Bad Request`.

After `Send`, the request feedback strip shows `sending`, `success`, or `failed`, plus endpoint, HTTP status, duration,
and the most useful error message. The response area shows status, duration, body kind, classified error, parsed JSON or
raw text, response headers, and the generated command. Single REST requests also emit `rallar.server.rest.request.*`
events that are visible in `Rallar Trace` with full redacted payloads and response bodies. Response text, response URLs,
command previews, copied output, and trace payloads are redacted for sensitive keys, access tokens, bearer values,
tickets, cookies, and known secret values from the active session. In `browser-rallar` mode the tab refuses to send
real-provider requests to the placeholder `https://api.example.invalid` API base URL.

## Flow Builder

The `Flow Builder` tab composes command-center flows without starting from an empty recipe file.

Controls:

- template selector
- variables JSON
- flow JSON
- add-step buttons for auth login, REST request, WS open/send, RTC connect/send, wait, and cleanup

Actions:

- `Normalize JSON`: reformat the editable flow JSON
- `Run Flow`: execute the generated SPA recipe through `recipe.run`
- `Copy SPA Recipe`: copy the generated `rallar-bb-test` recipe
- `Copy Runner Scenario`: copy a black-box-runner-style scenario

The tab shows step status, command links, expected result metadata, extraction metadata, a SPA recipe preview, and a
runner scenario preview. Variables can use `{{name}}`, `${name}`, or `{name}` placeholders. Exact placeholders preserve
structured values, so a payload variable can become a JSON object instead of a string.

## Shared Test

The `Shared Test` tab bridges the SPA command center to `packages/shared-test/black-box-runner`.

The recipe catalog shows:

- app-local example recipes
- selected shared-test fixture catalog entries
- provider mode
- live/dry-run support
- profiles and badges
- required env vars, HTTP services, and Playwright gates
- copyable root matrix and direct scenario commands

The browser does not execute shell commands. Commands are copied for explicit local use or later control-server
orchestration.

The artifact import panel accepts runner artifact bundle files:

- `report.json`
- `events.jsonl`
- `failures.json`
- `metadata.json`
- optional `expanded-plan.json`
- optional `matrix-summary.json`

Imported bundles are validated before display. Valid artifacts are projected into imported summary, event stream, RTC
diagnostics, failure-focus, and replay-recipe views.

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
