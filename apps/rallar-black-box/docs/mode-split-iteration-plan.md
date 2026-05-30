# Rallar Mode Split Iteration Plan

Date: 2026-05-29

This document proposes a product split for `apps/rallar-black-box` after reviewing the current SPA docs, command-center
iteration plan, shared-test runner handoff docs, and the browser Rallar facade surface.

The core recommendation is to make two top-level operating modes:

- `Rallar`: an interactive console for one operation at a time against a real Rallar backend.
- `Rallar black-box-runner`: the existing recipe, control-server, artifact, and runner workflow for repeatable
  black-box tests that are too complex for a direct UI.

The split should be visible near the current `Rallar Browser Trace`/global context area, but it should be treated as an
application mode selector, not only as a trace filter. The trace should then explain the selected mode and show events
from the selected execution source.

## Opinion

The split makes sense. The current SPA has two different jobs in one navigation model:

- direct operator work: log in, join a group, send and receive real messages, inspect live Rallar state
- test-runner work: load recipes, run multi-agent scenarios, import artifacts, compare reports

Those jobs share authentication, environment config, event display, redaction, and diagnostics, but their mental models
are different. Direct Rallar mode should feel like a live operational console. Black-box-runner mode should feel like a
scenario and evidence workbench. Keeping them separate will reduce accidental simulated/runner assumptions when the
user expects real traffic.

## Sources Reviewed

- `apps/rallar-black-box/docs/current-state.md`
- `apps/rallar-black-box/docs/ui-user-manual.md`
- `apps/rallar-black-box/docs/capability-matrix.md`
- `apps/rallar-black-box/command-center-improvement-iterations.md`
- `apps/rallar-black-box/implementation-plan.md`
- `apps/rallar-black-box/src/app-tabs.ts`
- `packages/shared-test/black-box-runner/docs/black-box-runner-command-center-handoff.md`
- `packages/shared-test/black-box-runner/docs/black-box-runner-recipe-guide.md`
- `packages/shared-test/rallar-bb-test/docs/companion-coverage.md`
- `packages/shared-web/browser/rallar.ts`
- `packages/shared-web/browser/rallar-data.ts`

## Mode Boundaries

### Rallar Mode

Rallar mode is for direct, real backend operations through the browser Rallar facade and API-v1 REST endpoints.

This mode should:

- require or restore a real login session
- use real API base URL, application, workspace, client, session, and group values
- call the browser Rallar facade directly for facade-owned actions
- show live Rallar lifecycle/status events as the primary trace
- make single-step operations easy and inspectable
- support a guided happy path for common testing
- avoid simulated/fake loopback behavior

The Rallar mode tabs now covered by this plan are:

- `Quick Test`: guided Login -> Join group -> Subscribe/view messages -> Send messages -> Repeat flow
- `Auth`
- `Groups/Clients`
- `WebSocket`
- `RTC/Realtimes`
- `RTC Diagnostics`
- `Topology`
- `Rallar Data`
- `Media`
- `Rallar Server`
- `Event Stream`
- optional advanced: `Advanced/Middleware`

### Rallar Black-box-runner Mode

Black-box-runner mode is for the existing shared-test and control-server workflow.

This mode should:

- use the `rallar-bb-test` and `black-box-runner` command vocabulary
- show recipes, runner catalog entries, flow builder output, control runs, artifacts, and imported runner evidence
- preserve the guardrail that JSON recipes express HTTP, WS, RTC, ASSERT, and SET behavior, not direct facade method
  calls such as `rallar.auth.login` or `rallar.messages.ws.send`
- keep shell execution explicit through local tooling or the control server
- support multi-agent and large-run scenarios that do not fit a hand-operated UI

The runner mode tabs covered or preserved by this plan are:

- `Shared Test`
- `Manual Rallar`
- `Local Workbench`
- `Flow Builder`
- `Run Manager`
- `Artifacts/Reports`
- `Event Stream`
- shared `Topology` and `RTC Diagnostics` evidence from the event stream

## Rallar Aspects To Cover

The user's proposed Rallar-mode list is right: `Auth`, `Groups/Clients`, `WebSocket`, `Topology`, `RTC Diagnostics`, and
`Rallar Data` are core. The split tracks these Rallar aspects:

- `Realtime`: direct `rallar.realtime.sendJson`, `sendBinary`, lane subscriptions, lane health, and per-peer lane
  readiness.
- `Messages RTC`: `rallar.messages.rtc.send`, `onMessage`, direct/multicast/broadcast metadata, NACK/min-snapshot
  behavior, and typed channel helpers.
- `Typed message channels`: `rallar.messages.channel(...)` over WS and RTC with a shared selector/payload model.
- `WS lifecycle`: not only raw sockets, but `rallar.ws.status`, `onStatus`, `onLifecycle`, and `waitForOpen`.
- `RTC lifecycle`: `rallar.rtc.status`, `onStatus`, `onLifecycle`, `waitForOpen`, `waitForLane`, and
  `waitForRoomLane`.
- `People/state events`: people refresh/list/get, room events, people events, event pages, and event replay.
- `Subscriptions`: scoped cleanup for active listeners so UI receive state is trustworthy.
- `Defaults/config`: visible `rallar.configure`, `setDefaults`, current defaults, and operation timeout/retry settings.
- `Rallar Data`: define/open/hydrate/read/write/update/compare-and-set/flush/export/clear/destroy/storage estimates.
- `Media`: local stream, audio/video toggles, media policy, and remote stream events.
- `Cleanup`: leave room, disconnect, logout, close subscriptions, clear scoped data, and reset local browser state.
- `Advanced middleware`: useful for diagnostics, but should remain read-only/advanced unless a concrete test need
  requires it.

## Common Rallar Test Flow

The most important Rallar-mode workflow should be a guided path:

1. Confirm backend and login state.
2. Select or create application/workspace/group context.
3. Join the group and show server-side membership evidence.
4. Subscribe to WS and/or RTC receive paths.
5. Send a JSON message to the group over WS, `messages.rtc`, or realtime.
6. Show received messages in the same view, including sender, transport, selector, context, and latency.
7. Keep the payload editor open so the user can send again without reconfiguring.
8. Offer copyable diagnostics when something fails.

This should become the default first screen in Rallar mode. A user should not have to understand every tab before they
can prove "Alice joined group X and sent a real payload that Bob received."

## Proposed Iterations

### Mode Split Iteration 1: Mode Model And Navigation Contract

Status: completed on 2026-05-29.

Goal: Define the two top-level modes without changing behavior yet.

Work:

- Add a documented mode model: `rallar` and `black-box-runner`.
- Decide URL/query/storage naming, for example `?workspace=rallar` or `?modeView=rallar`.
- Split the current tab list into mode-owned tab groups.
- Keep the current tabs mounted only inside their owning mode.
- Make the current `Rallar Browser Trace` area show the active mode and event source.
- Preserve deep links for existing `?tab=...` values with aliases.

Exit criteria:

- Users can switch between Rallar mode and black-box-runner mode without losing global context.
- Existing tab links keep working through aliases.

Result:

- Added a top-level workspace mode model with `rallar` and `black-box-runner` modes.
- Added a mode switch above the tab list and connected it to URL/storage state through the `workspace` query parameter.
- Split visible tabs by mode while preserving existing `?tab=...` deep links.
- Kept shared `Event Stream` available in both modes.
- Updated the Rallar Browser Trace strip to show the active mode and event source.
- Kept existing panel state mounted so manual form drafts and runner workbench state survive mode switches.

### Mode Split Iteration 2: Direct Rallar Operation Boundary

Status: completed on 2026-05-29.

Goal: Create a direct Rallar operation layer that is separate from runner command execution.

Work:

- Add a small direct-Rallar action/event model for UI operations.
- Route direct Rallar mode actions through `@shared-web/browser/rallar.ts`, not through fake runner commands.
- Normalize direct action results into the shared event stream and trace without calling them black-box-runner results.
- Add explicit `real backend required` empty/error states.
- Ensure Rallar mode never silently falls back to simulated provider behavior.

Exit criteria:

- A direct UI operation can call the browser Rallar facade, report status, emit trace events, and render diagnostics
  without going through a recipe command.

Result:

- Added `src/direct-rallar-operations.ts` as the direct Rallar operation boundary.
- Added a direct `status.check` operation that refuses simulated provider mode, configures the browser Rallar facade,
  applies global application/workspace/group defaults, starts/connects the facade, and emits `rallar.direct.*` events.
- Added a `Direct Rallar Operations` panel in Rallar mode with an explicit real-backend-required state for simulated
  mode.
- Routed direct operation events into the existing event stream and Rallar Browser Trace without creating
  black-box-runner command results.
- Added unit coverage for the no-fallback guard and the facade-backed direct status check.

### Mode Split Iteration 3: Rallar Quick Test Flow

Status: completed on 2026-05-29.

Goal: Provide the common manual flow as one user-friendly screen.

Work:

- Add a `Quick Test` Rallar-mode tab.
- Include backend/session summary, group selector/create/join controls, message payload editor, transport selector,
  subscribe/listening status, send button, and received messages.
- Support at least WS group send and receive first.
- Show which browser is sender/receiver and which group/type/topic/context is active.
- Keep the payload editor and group context stable for repeated sends.
- Add copy diagnostics for failed login, join, subscribe, send, and receive-timeout cases.

Exit criteria:

- With two browsers logged into the same real backend, a user can join a group, subscribe, send a real WS group message,
  and see it received without opening multiple specialized tabs.

Result:

- Added `Quick Test` as the default Rallar-mode tab.
- Added direct `group.create`, `group.join`, `ws.subscribe`, and `ws.send` operations to the direct Rallar boundary.
- The Quick Test screen shows backend/session/group/signaling status, group create/join controls, a WS transport
  selector, type/topic/context/resource routing fields, a stable payload editor, send/subscribe/wait controls, and a
  received-message panel.
- `Create and join group` uses the typed browser Rallar facade, passes the current Group text as the explicit group ID,
  and keeps Global Context on that same value.
- `Subscribe WS` registers a real `rallar.messages.ws.onMessage(...)` subscription, starts/connects Rallar signaling,
  joins the selected group, and records `rallar.direct.ws.*` diagnostics.
- Received WS messages are shown in the Quick Test panel and emitted as `rallar.direct.ws.message` events for the trace
  and event stream.
- Added copyable redacted diagnostics for the active Quick Test context, subscription, last result, errors, wait status,
  and recent received messages.
- Added unit coverage for the new direct group and WS operations plus Playwright coverage for the default Quick Test
  tab and mode isolation.

Remaining scope:

- This iteration intentionally supports WS group messages first. RTC messages, realtime lanes, and typed channel
  variants remain in later Rallar-mode iterations.

### Mode Split Iteration 4: Auth And Session Console

Status: completed on 2026-05-29.

Goal: Make direct auth/session behavior obvious and reliable in Rallar mode.

Work:

- Keep login/register/restore/logout, but present them as direct Rallar facade/API actions.
- Add current session lifetime, access-token presence, client ID, session ID, and username.
- Add session switch guidance for running Alice/Bob/Charlie in separate browsers.
- Add WS-ticket creation and expiry checks as auth-adjacent actions.
- Add negative auth cases: bad credentials, missing token, expired token where the backend can support it.

Exit criteria:

- The user can tell whether the browser is logged in, which session is active, and whether REST/WS calls should be
  authorized.

Result:

- Kept login, register-and-login, restore, logout, and local clear in the Rallar-mode Auth tab.
- The Auth tab now shows access-token presence, username, client ID, session ID, session expiry, session TTL,
  WS-ticket presence, ticket expiry, and ticket TTL.
- Added explicit multi-browser guidance for Alice/Bob/Charlie style testing, including the requirement that Global
  Context session values match the active browser auth session.
- Kept WS-ticket creation next to auth state and added missing-auth plus expired-session WS-ticket negative probes.
- Playwright coverage now checks the Auth session evidence, TTL fields, guidance, WS-ticket action, and negative probes
  while asserting tokens/passwords stay redacted.

### Mode Split Iteration 5: Rooms, Clients, Presence, And State Events

Status: completed on 2026-05-29.

Goal: Make group membership and client presence the source of truth before messaging.

Work:

- Keep group/client list filters and sorting.
- Add direct create/join/leave/refresh actions backed by Rallar facade where possible and API-v1 where needed.
- Show expected vs observed members for the active group.
- Add room event and people event replay/page controls.
- Add cleanup actions for leaving group, disconnecting client presence, and clearing local context.
- Add assertions in the UI for "current client is a member" and "other browser is visible".

Exit criteria:

- Before sending a message, the user can prove from the UI that the expected clients are currently members of the
  selected group.

Result:

- Kept group/client filters and sorting for member/online visibility.
- Added direct browser Rallar room actions for refresh, create, join, and leave alongside the existing API-v1 REST
  actions.
- Kept REST actions for group/client/session/presence/event endpoints where server-side evidence is needed.
- The Groups/Clients tab now shows explicit `Current client member` and `Other browser visible` assertions for the active
  group/session and a user-supplied expected other client.
- State event page controls remain available for group and client events, and cleanup remains available through leave,
  group presence disconnect, and client session disconnect.
- Playwright coverage checks the membership assertions, expected-other-client control, filters, sorting, event rows,
  and direct-action guard state.

### Mode Split Iteration 6: WebSocket And Message Channels

Status: completed on 2026-05-29.

Goal: Make Rallar app-level WS messaging separate from raw socket testing.

Work:

- Split `Rallar WS Messages` from `Raw WebSocket`.
- For Rallar WS, use `rallar.messages.ws.send`, `onMessage`, `ws.status`, `onStatus`, `onLifecycle`, and `waitForOpen`.
- Include group/all/world scope, type/topic/context/resource fields, typed-channel presets, and received-message
  history.
- Keep raw `Open API WS` as a lower-level socket/ticket diagnostic section.
- Add received-message correlation with sender session and route metadata.

Exit criteria:

- It is unambiguous whether a button sends a Rallar app message or a raw socket payload.

Result:

- The WebSocket tab now groups app-level actions under `Rallar WS Messages` and lower-level ticket/socket actions under
  `Raw WebSocket Diagnostics`.
- Rallar WS actions continue to use `rallar.messages.ws.send(...)` and `rallar.messages.ws.onMessage(...)` for real
  app messages.
- Rallar WS defaults now use Rallar Server user topic prefixes: `room.manual.message` for group delivery,
  `app.black-box.ws.ping` for all-subscriber ping, and `room.black-box.transport-check` for WS/RTC comparison probes.
  Direct WS operations validate the effective topic before sending or subscribing.
- Added a direct `Wait Rallar WS open` action backed by the browser Rallar facade `ws.waitForOpen(...)`.
- Raw socket actions remain available for configure, ticket, open, reconnect, close, cleanup, and missing-ticket
  diagnostics.
- Route preview, group/all/world scope, type/topic/context/resource controls, and received-message history remain in
  the Rallar WS flow.
- Playwright coverage checks that the two WS sections are visible and that the Rallar WS wait action is guarded outside
  `browser-rallar`.

### Mode Split Iteration 7: Realtime And RTC Messaging

Status: completed on 2026-05-29.

Goal: Cover the Rallar realtime and `messages.rtc` surface directly.

Work:

- Add a `RTC/Realtimes` Rallar-mode tab or split the current Manual Rallar tab into focused sections.
- Support `realtime.sendJson`, `sendBinary`, `onJson`, `onBinary`, lane selection, peer selection, and lane health.
- Support `messages.rtc.send`, `onMessage`, direct/multicast/broadcast metadata, min snapshot, TTL, reliability, ack,
  ownership, ordering key, and overlay/fanout controls.
- Add `waitForOpen`, `waitForLane`, and `waitForRoomLane` actions with clear ready/not-ready output.
- Keep received messages visible near the send controls.

Exit criteria:

- A user can test realtime lanes and `messages.rtc` group delivery directly, with visible receive state and lane
  readiness diagnostics.

Result:

- Added a `RTC/Realtimes` Rallar-mode tab.
- Added direct controls for `realtime.sendJson`, `realtime.onJson`, `messages.rtc.send`, `messages.rtc.onMessage`,
  `rtc.waitForRoomLane`, and `realtime.health`.
- The tab exposes lane ID, peer IDs, type/topic/context, min snapshot, reliability, ack, ownership, payload JSON, and
  timeout controls.
- Received realtime and RTC message rows are visible beside the send controls and are emitted as `rallar.direct.*`
  diagnostics.
- Added a runner-recipe export for the focused RTC/realtime configuration.
- Playwright coverage checks that the tab is present and guarded outside a real `browser-rallar` backend.

### Mode Split Iteration 8: Rallar Data Console

Status: completed on 2026-05-29.

Goal: Add a first-class UI for `rallar.data`.

Work:

- Add a `Rallar Data` tab in Rallar mode.
- Support define/open/lookup/close/destroy store.
- Support hydrate, read/get, list keys, entries, set, update, update-or-create, set-if-absent, compare-and-set,
  get-and-set, delete, deleteExpired, clear, flush, export, and estimateUsage.
- Include scope selection: app, principal, session, and custom scope.
- Show store hydration/idle state and change events.
- Add redaction for values and copyable diagnostics.

Exit criteria:

- The user can create a scoped store, write/read/update values, export the data, and verify cleanup against a real
  browser session.

Result:

- Added a first-class `Rallar Data` tab in Rallar mode.
- Added scoped store controls for app, principal, session, and custom scopes, with durability and hydration settings.
- Added an operation selector covering define, open, lookup, hydrate, idle, read/get, keys/list, entries, set, update,
  update-or-create, set-if-absent, compare-and-set, get-and-set, delete, deleteExpired, clear, flush, export,
  estimateUsage, close, destroy, and scope cleanup actions.
- Added store hydration/open status, change-event display, redacted result rendering, and copyable diagnostics.
- Playwright coverage checks tab visibility and real-backend guardrails.

### Mode Split Iteration 9: Rallar Trace, Diagnostics, And Topology

Status: completed on 2026-05-29.

Goal: Make the trace a direct Rallar observability surface in Rallar mode.

Work:

- Separate direct Rallar trace events from runner/imported artifact events.
- Show WS lifecycle, RTC lifecycle, room events, people events, realtime messages, message-channel events, and cleanup.
- Keep topology derived from live Rallar events in Rallar mode.
- Keep artifact topology/diagnostics in runner mode.
- Add filters by transport, group, peer, type/topic, and operation.

Exit criteria:

- A user can inspect the exact live Rallar sequence for login, join, subscribe, send, receive, disconnect, and cleanup.

Result:

- Kept the top Rallar Browser Trace focused on live `rallar.browser.*` and `rallar.direct.*` events in Rallar mode.
- Kept runner/control/imported artifact evidence isolated in black-box-runner mode.
- Extended Event Stream filtering with group, peer, and selector filters in addition to kind, command, connection,
  actor, transport, severity, and topic.
- Direct WS, RTC/realtime, Data, and Media operations now emit `rallar.direct.*` diagnostics for trace/event-stream
  inspection.
- Playwright coverage checks the new live-event filter controls.

### Mode Split Iteration 10: Rallar Server API Front-end Alignment

Status: completed on 2026-05-29.

Goal: Keep REST API testing in Rallar mode while preserving runner export.

Work:

- Keep the current `Rallar Server` REST workbench in Rallar mode.
- Make active login/session/global context the default for all REST actions.
- Add guided endpoint groups for auth, groups, clients, presence, events, and WS tickets.
- Keep recipe/export buttons, but label them as runner exports.
- Add "use result in Quick Test" actions for group/client/session values.

Exit criteria:

- REST API calls feel like part of the direct Rallar console, while recipe export remains available for automation.

Result:

- Kept the Rallar Server REST workbench in Rallar mode with active auth/global context defaults.
- Kept guided endpoint presets, OpenAPI refresh, raw request editing, auth header injection, cURL export, command export,
  REST collections, assertions, extraction, and collection recipe export.
- Added `Use group in Quick Test`, `Use client globally`, and `Use session globally` actions that promote values from
  the latest REST response into Global Context.
- Playwright coverage checks response-to-global-context promotion.

### Mode Split Iteration 11: Runner Mode Workspace Re-grouping

Status: completed on 2026-05-29.

Goal: Move existing runner-oriented UI into the black-box-runner mode.

Work:

- Group `Shared Test`, `Local Workbench`, `Flow Builder`, `Run Manager`, and artifact import/export under runner mode.
- Make runner mode explain that it runs recipes and imports evidence, not direct facade operations.
- Keep the shared-test handoff contract as the source for catalog and artifact display.
- Preserve copyable commands and control-server mediated execution.
- Add migration/deep-link aliases for existing tabs.

Exit criteria:

- A user who wants recipes, multi-agent runs, or artifacts has one clear place to go.

Result:

- Runner-owned tabs remain grouped under the `Rallar black-box-runner` workspace: Shared Test, Local Workbench, Flow
  Builder, Run Manager, and Event Stream.
- Added a runner-mode boundary panel explaining that the workspace runs recipes, control-server work, flow exports, and
  imported evidence rather than direct browser Rallar facade operations.
- Preserved deep-link aliases for existing runner-owned tabs.
- Playwright coverage checks the Quick Test handoff into runner mode and the runner boundary.

### Mode Split Iteration 12: Cross-mode Promotion And Evidence

Status: completed on 2026-05-29.

Goal: Let useful Rallar-mode explorations become runner-mode tests without merging the two modes.

Work:

- Add "Export as runner recipe" from Quick Test, Rallar WS, Realtime/RTC, Groups/Clients, and Rallar Server.
- Add "Open in runner mode" for exported recipes.
- Include environment prerequisites in exported recipes.
- Add copyable direct-Rallar diagnostic bundles independent from runner artifacts.
- Keep redaction consistent across both modes.

Exit criteria:

- A manual Rallar investigation can become a repeatable black-box-runner recipe with a clear handoff.

Result:

- Added `Copy runner recipe` and `Open runner mode` actions to Quick Test.
- Kept Rallar WS recipe export and WS/RTC comparison recipe export in the WebSocket tab.
- Added RTC/realtime runner-recipe export from the new RTC/Realtimes tab.
- Kept Groups/Clients state recipe export and Rallar Server command/collection recipe exports.
- Copyable direct diagnostics remain independent from runner artifacts and use existing redaction.

### Mode Split Iteration 13: Real-data Browser Automation

Status: completed on 2026-05-29.

Goal: Validate the redesigned Rallar mode with real backend, real data, and multiple browsers.

Work:

- Add Playwright coverage for Rallar mode login, create/join group, subscribe WS, send WS, receive in another browser,
  repeat send, and cleanup.
- Add coverage for Groups/Clients membership evidence before send.
- Add coverage for realtime/RTC direct send and received message display.
- Add coverage for Rallar Data store write/read/update/cleanup.
- Keep tests skip-safe unless real local services and credentials are configured.

Exit criteria:

- The common Rallar workflow is proven by automation against a real backend with at least two browsers.

Result:

- Added a gated full-stack Quick Test Playwright scenario for two real browsers.
- The test logs in two users, creates/joins a group, subscribes the receiver, sends two real WS payloads from the sender,
  and verifies both payloads appear in the receiver's Quick Test received-message panel.
- The test is skip-safe behind the existing `RALLAR_BLACK_BOX_FULL_STACK` configuration.
- Existing gated suites continue to cover Manual Rallar realtime delivery, browser-rallar resilience, REST workbench,
  control orchestration, and live RTC matrices.

### Mode Split Iteration 14: Optional Media Console

Status: completed on 2026-05-29.

Goal: Add media testing only if Rallar media behavior needs visible manual validation.

Work:

- Add local stream attach, audio/video enable toggles, stop local, media policy, and remote stream event display.
- Keep permissions and device errors explicit.
- Add tests with mocked media where possible and gated real-browser checks where useful.

Exit criteria:

- Media controls exist without cluttering the core message/data testing flow.

Result:

- Added a compact optional `Media` tab in Rallar mode.
- Added local stream attach, audio/video toggles, stop audio/video/all, media policy JSON, remote stream subscription,
  remote stream display, and copyable diagnostics.
- Permission/device/backend failures are surfaced as explicit status/error messages.
- The media surface stays outside Quick Test so it does not clutter the core message/data flow.
- Playwright coverage checks tab visibility and real-backend guardrails.

## Post-14 Review

Status: completed on 2026-05-29.

Iterations 1-14 complete the mode split scope:

- direct Rallar mode has a distinct navigation model, guided Quick Test flow, auth/session visibility, groups/clients
  evidence, WS message operations, RTC/realtime operations, Rallar Data operations, optional Media operations, REST API
  promotion, and trace filtering
- black-box-runner mode remains the recipe/control/artifact workspace, with an explicit boundary panel and promotion
  paths from direct UI evidence into copyable runner recipes
- deterministic browser coverage exercises the mode shell, tab guardrails, REST promotion, auth/session console,
  groups/clients evidence, WebSocket command-center behavior, RTC matrix UI, flow builder, shared-test handoff, and
  persistence
- live-browser coverage has a new gated Quick Test two-browser WS delivery scenario alongside the existing gated
  full-stack suites

No additional mode-split iterations are required before returning to the broader command-center and live-environment QA
backlogs. The remaining work is not another structural split; it is provisioned-environment depth:

- run the gated live suites regularly against a known-good Rallar Server plus control server
- add stable fixtures for forbidden/expired/CORS/missing-peer/stale-agent/duplicate-session cases
- expand live RTC, WS-vs-RTC parity, Rallar Data, and media checks once the target backend environment is provisioned
- continue the large-run artifact, retention, virtualization, and monitor-server integration work tracked in the
  command-center and current-state docs

## Historical Suggested Order

Iterations 1 and 2 were done first because they are the structural guardrails.

Iteration 3 followed before deepening individual tabs. The guided Quick Test flow revealed the right shape for the
specialized Rallar mode surfaces.

After that, the implemented priority order was:

1. Iteration 6 for WS messages, because that is the current pain point.
2. Iteration 5 for membership evidence, because messaging failures are hard to debug without it.
3. Iteration 7 for RTC/realtime.
4. Iteration 8 for Rallar Data.
5. Iteration 11 for runner mode cleanup once the direct mode has a clear shape.

## Resolved Design Decisions

- `Manual Rallar` is an advanced black-box-runner scratchpad. Direct Rallar mode uses `Quick Test` plus focused tabs,
  and those tabs execute through Rallar/Rallar Server directly rather than through `browser-rallar-runtime.ts`.
- The local scaffold sample and `Replay Sample` header action are black-box-runner-only; direct Rallar mode does not
  bootstrap or replay simulated command recipes.
- The mode selector sits above the tab list and shares the global context instead of becoming a separate side shell.
- Direct Rallar mode still renders in simulated/offline development mode, but real facade actions show explicit
  real-backend-required guardrails and do not silently fall back.
- `Rallar Server` remains the advanced REST workbench, while result-promotion actions feed group/client/session values
  back into the global context and Quick Test.
- `advanced.middleware()` is not exposed by this pass; it should stay read-only/advanced until a concrete diagnostic
  workflow needs it.
