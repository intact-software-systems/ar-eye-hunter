# Rallar Black Box Command Center Gap Analysis

Date: 2026-05-27

This document reviews `apps/rallar-black-box/**` and
`apps/rallar-black-box-control-server/**`, with extra attention to docs and
examples. It outlines gaps and improvement iterations for making
`apps/rallar-black-box` a SPA command center for testing Rallar over HTTP, WS,
and RTC.

## Command Center Goal

`apps/rallar-black-box` should be the visible command center for Rallar testing:

- authenticate users and inspect auth/session state
- create, join, leave, and inspect rooms/groups
- inspect clients, sessions, presence, and state events
- execute HTTP requests against Rallar Server
- open, send, receive, reconnect, and close WebSocket traffic
- connect RTC clients and send realtime or `messages.rtc` payloads
- compare HTTP, WS, and RTC behavior for the same rooms, clients, and payloads
- turn useful manual flows into repeatable recipes and automation

The SPA should still delegate real Rallar behavior to the browser Rallar facade
and public server APIs. It should not reimplement Rallar routing, WebRTC,
message queues, room state, or server internals.

## Sources Reviewed

- `apps/rallar-black-box/implementation-plan.md`
- `apps/rallar-black-box/docs/**`
- `apps/rallar-black-box/examples/**`
- `apps/rallar-black-box/src/**`
- `apps/rallar-black-box-control-server/src/**`
- `apps/rallar-black-box-control-server/test/**`
- `tests/playwright/rallar-black-box/**`
- `packages/tests/rallar-black-box/**`
- `packages/shared-test/rallar-shared-test-gap-analysis.md`
- `packages/shared-test/black-box-runner/docs/**`
- `packages/shared-test/black-box-runner/examples/**`
- `packages/shared-test/rallar-bb-test/docs/**`

## Current Strengths

The SPA is already a strong foundation:

- default simulated provider works out of the box without login
- `browser-rallar` mode has a login gate and restored-session path
- tabbed shell exists for Auth, Manual Rallar, Rooms/Clients, WebSocket,
  Topology, RTC Diagnostics, Local Workbench, Event Stream, Rallar Server, and
  Shared Test
- Auth tab can exercise login, register-and-login, restore, logout, local clear,
  WS-ticket creation, and basic negative auth checks with redacted diagnostics
- Rooms/Clients tab can exercise group, client, presence, and state-event REST
  calls with live state tables and expected/observed client metrics
- Manual Rallar can configure, create/join group, connect, send, health, close,
  reset, and generate recipe snippets
- Rallar Server tab can send authenticated REST requests, use curated presets,
  refresh OpenAPI endpoint rows, export cURL, export `http.request` commands,
  and run REST collections with variables, extraction, and assertions
- WebSocket tab can configure/open/send/wait/reconnect/close sockets, create
  authenticated API WS tickets, run a missing-ticket negative open, inspect WS
  event evidence, and export WS or WS/RTC parity recipes
- received-data inbox, event stream, stats, failure focus, and topology are
  event-derived
- control client can register, receive commands, stream results/events/stats, and
  upload final reports
- control server has in-memory runs, agents, commands, results, stats, reports,
  tokens, Swagger UI, validation, allowlists, and rate limits
- full-stack Playwright coverage exists for simulated UI, control orchestration,
  REST workbench, real Manual Rallar realtime delivery, two-agent delivery, and
  browser Rallar resilience paths
- full-stack QA ownership is tracked in code through
  `src/full-stack-qa-matrix.ts`
- the SPA has bounded Event Stream windows, topology search/node limits, and
  deterministic route summaries for larger multi-agent runs
- a gated live three-browser Playwright baseline now covers direct, multicast,
  broadcast, NACK/min-snapshot probing, stale-send failure, and artifact export
  across `realtime` and `messages.rtc`
- shared-test Iterations 1-19 now provide a stronger external runner foundation:
  recipe docs, REST/WS/RTC examples, scoped provider pass-through, diagnostics,
  delivery/NACK examples, remote-browser parity, redacted artifacts, repeated
  scale mode, companion coverage boundaries, recipe matrix profiles,
  same-connection soak, seeded traffic replay, bounded parallel groups, package
  verification, a command-center handoff contract, and gated live-provider
  soak/traffic/parallel baselines, artifact parsers, versioned fixtures, and
  compatibility checks
- shared-test now exports browser-safe handoff fixtures through
  `apps/rallar-black-box/src/shared-test-handoff-fixtures.ts`

## Checkpoint After Shared-test Iteration 19

The command center should now build on the shared-test runner instead of
duplicating it. The runner has become the place for JSON recipe execution,
provider-neutral HTTP/WS/RTC assertions, artifacts, redaction, scale summaries,
same-connection soak, seeded traffic replay, bounded parallel groups, companion
coverage guardrails, a stable catalog/artifact handoff contract, and gated live
browser/remote-browser baselines for the high-risk RTC patterns. The runner now
also exposes artifact parsers and versioned schema fixtures, so artifact import
can validate uploaded bundles before the SPA displays them.

That changes the SPA roadmap:

- import or surface the shared-test recipe catalog through the handoff contract
- display runner artifact bundles through the shared artifact contract instead
  of inventing a second report format
- keep manual UI flows focused on exploration, diagnostics, and orchestration
- export command-center flows into the shared recipe vocabulary when possible
- leave facade-level correctness in shared-web/shared-server/rallar-bb-test
  companion tests

## Main Gaps

### 1. Auth Workbench Needs Deeper Real-backend Matrices

Iteration 28 added a visible Auth tab for login, register-and-login, restore,
logout, local session clear, WS-ticket creation, bad-credentials checks,
missing-auth-ticket checks, redacted diagnostics, and auth recipe snippets.
Remaining gaps are deeper real-backend and multi-user coverage:

- token expiry, forbidden user, CORS denial, and network denial need fuller
  full-stack/live coverage
- ticket expiry and WS open failures should connect to the planned WS command
  center
- switching between multiple users/sessions in one testing session is still
  cumbersome

### 2. Rooms And Clients Need Saved Scenarios And Assertions

Iteration 29 added a Rooms/Clients tab with reusable server variables, group and
client REST actions, presence actions, state-event actions, live state tables,
and expected-versus-observed client metrics. Remaining gaps are repeatability
and scale:

- saved state scenarios and explicit assertions are not implemented yet
- cleanup isolation for create/join/leave/disconnect flows needs stronger
  coverage
- application/workspace/scope fields still need tighter integration with Manual
  Rallar and future RTC delivery recipes
- large state-event pagination and browsing remain planned

### 3. REST Workbench Needs Visual Flow Builder And Runner Alignment

Iteration 30 added REST collections, named variables, response extraction,
status/body/header assertions, negative templates, persisted collection drafts,
and collection recipe export. Remaining gaps are now about scale and alignment:

- collection import is still paste/edit based rather than a guided visual flow
  builder
- collection assertions execute in the SPA, but full shared-runner assertion
  execution still belongs to exported recipes
- saved collection scenarios are local browser drafts, not shared durable
  artifacts
- large collections need clearer run summaries, filtering, and failure bundle
  export

### 4. WebSocket Testing Needs Real-backend Matrices

Iteration 31 added a dedicated WebSocket command center with ticket creation,
open/open API WS, send, wait, reconnect, close, cleanup, negative missing-ticket
open, status, recent event evidence, payload presets, and WS/RTC parity recipe
export. Remaining gaps:

- expired-ticket, unauthorized socket, and intentional close scenarios need
  live backend coverage
- server restart/reconnect behavior needs full-stack automation
- WS-vs-RTC parity needs multi-agent real-provider assertions
- standard Rallar Server WS topic/message templates should grow from real
  production usage

### 5. RTC Real-provider Coverage Needs Negative-fixture Hardening

The SPA has real `browser-rallar` RTC paths and tests, and shared-test now has
scoped, diagnostic, multicast, NACK, provider-parity, and WS/RTC parity recipes.
Iteration 32 added scoped Manual Rallar fields, realtime and `messages.rtc`
delivery matrix buttons, negative RTC recipe export, a NACK probe, and visible
ready/active peer, lane-health, and NACK diagnostics. Iteration 38 added the
first skip-safe three-browser live baseline for direct, multicast, broadcast,
NACK/min-snapshot probing, stale-send failure, and artifact export. Remaining
gaps are now mostly provisioned negative fixtures:

- permission-denied, forbidden user, expired token, expired ticket, and CORS
  denial need stable live fixture coverage
- exact server-provided NACK semantics should be tightened once the provisioned
  environment exposes a stable contract
- missing-peer, stale-agent, and duplicate-session cases need dedicated
  real-provider assertion coverage beyond the current closed-transport probe
- `waitForRoomLane` and lane-level diagnostics can still become more actionable
  as Rallar exposes more live lane state
- scoped addressing examples should be expanded with environment-specific
  successful baselines

### 6. SPA Examples Are Too Few And Too Hardcoded

Current SPA examples:

- `rallar-server-group-ws-setup.recipe.json`
- `rallar-server-rtc-connect-send.recipe.json`

The broader shared-test example set is now richer, but the SPA examples still
have these gaps:

- only two app-local JSON recipe examples exist
- examples hardcode `ar-eye-hunter`, `default`, and `bb-group`
- no examples for clients, presence heartbeats, leave/cleanup, REST assertions,
  WS send/receive, `messages.rtc`, multicast, broadcast, stale-session, or
  auth-negative flows
- examples require a logged-in browser session but do not show companion auth
  setup workflows
- the SPA now renders app-local recipes and selected shared-test fixture catalog
  entries, but it does not yet load the full matrix dynamically or generate new
  app-local examples for the missing flows above

### 7. Control Server Run Manager Needs Search And Comparison Depth

The control server is intentionally in-memory and local. Iteration 34 added the
first visible Run Manager plus bounded snapshots, bulk enqueue, reset, and
delete. Iteration 35 added optional snapshot persistence, artifact export,
JSONL/failure-bundle exports, and SPA artifact browsing. Remaining
command-center gaps:

- artifact search, multi-run filtering, and run comparison are still thin
- retention cleanup exists as an endpoint, but the SPA does not yet show
  retention previews or cleanup controls
- Swagger UI depends on external CDN assets, which is fragile for offline/local
  test environments
- large-run browsing uses bounded snapshots and UI windows, but not true cursor
  pagination

### 8. Docs Need Continuous Alignment After Each Command-center Slice

Iterations 26-31 refreshed the command-center docs, added capability/examples
guidance, added shared-test catalog/artifact docs, and documented the new Auth,
Rooms/Clients, REST Collection, and WebSocket command-center surfaces. Future
slices should keep the docs as the operating manual and update this plan with
actual results after each iteration.

### 9. Scale, Accessibility, And Large-run UX Need A Deeper Pass

Already documented Iteration 24B concerns are still relevant:

- event stream now has bounded windows, but true virtualization/cursor paging is
  still future work
- topology now has search and node limits, but very large graph sampling still
  needs performance testing
- bounded memory growth
- loading/empty/error states across tabs
- keyboard/focus/accessibility pass
- desktop and narrow viewport QA

## Proposed Iterations

These iterations started after the app Iteration 24A/25 work and the
shared-test Iteration 1-19 baseline. They are written as command-center
improvements rather than shared runner changes.

### Iteration 26: Command Center Baseline And Docs Alignment

Status: completed on 2026-05-28.

Goal: Make the current command-center state accurate and easy to build from.

Work:

- Update `docs/current-state.md`, `docs/ui-user-manual.md`, and
  `docs/full-stack-ui-automation-tests.md` with the current resilience tests,
  real-provider behavior, shared-test Iteration 1-19 capabilities, the handoff
  contract, and known limits.
- Add a command-center capability matrix for auth, rooms, clients, HTTP, WS,
  RTC, recipes, control server, diagnostics, artifacts, and scale.
- Document which features are simulated-only, real-provider, full-stack gated,
  shared-test-runner-backed, or planned.
- Add an examples index with prerequisites, required provider mode, required
  login/session state, expected results, and links to matching shared-test
  examples and catalog entries where they exist.

Exit criteria:

- A human can tell what the SPA can test today, what the shared-test runner
  covers, and what remains planned without reading source or Playwright specs.

Results:

- Updated the app docs index to describe the post-Iteration-24A SPA state and
  shared-test Iterations 1-19 runner/handoff state.
- Added `docs/capability-matrix.md` to separate simulated, real-provider,
  full-stack gated, shared-test-runner-backed, and planned command-center
  capabilities.
- Added `docs/examples-index.md` with app-local recipe prerequisites, shared-test
  recipe families, root commands, and artifact bundle shape.
- Updated current-state, command-execution, user manual, testing showcases,
  benefits/use-cases, full-stack automation guidance, and example README docs so
  same-connection soak, seeded traffic, bounded parallel groups, artifact
  readers, schema fixtures, and catalog handoff are no longer described as only
  future work.

Verification:

- Ran stale-reference scans for the updated docs and command-center plan.
- `npx vitest run packages/tests/shared-test/black-box-runner-artifact-reader.test.ts packages/tests/shared-test/black-box-runner-handoff-contract.test.ts packages/tests/shared-test/recipe-matrix.test.ts`
  passed.
- `npm run check:shared-test` passed.
- `npm run build:rallar-black-box` passed.
- `git diff --check` passed for the docs touched in this pass.

### Iteration 27: Shared-test Recipe Catalog And Artifact Bridge

Status: completed on 2026-05-28.

Goal: Let the command center reuse the completed runner recipes and artifact
contracts instead of inventing a parallel format.

Work:

- Use `RALLAR_BLACK_BOX_SHARED_TEST_RECIPE_CATALOG`,
  `RALLAR_BLACK_BOX_SHARED_TEST_ARTIFACT_CONTRACT`, and
  `RALLAR_BLACK_BOX_SHARED_TEST_COVERAGE_HANDOFF` as the first UI data source.
- Add a visible recipe catalog for app-local examples and selected
  `packages/shared-test/black-box-runner/examples/**` entries.
- Show each recipe's provider mode, required services, required env vars, login
  requirements, live/dry-run support, and expected outcome.
- Add import/display support for runner artifact bundles: `report.json`,
  `events.jsonl`, `failures.json`, `metadata.json`, optional
  `expanded-plan.json`, and optional `matrix-summary.json`.
- Use `parseRallarBlackBoxSharedTestArtifactBundle(...)` and the shared-test
  schema validators from `src/shared-test-handoff-fixtures.ts` before rendering
  uploaded artifacts.
- Map imported artifact events into the Event Stream, RTC Diagnostics, and
  failure-focus UI where possible.
- Add copyable root/shared-test command snippets from the shared-test catalog
  for dry-run, deterministic, soak, traffic, parallel, live-browser,
  remote-browser, and scale execution.
- Keep recipe execution itself behind explicit local tooling or the control
  server; the browser UI should not silently run arbitrary shell commands.

Exit criteria:

- A tester can discover a shared-test recipe from the SPA, understand how to run
  it, and inspect its redacted artifact bundle in the command center.

Results:

- Added a `Shared Test` tab and URL aliases for `catalog`, `recipes`,
  `artifacts`, `shared`, and `shared-test-runner`.
- Added an app-local recipe catalog section for the two SPA example recipes.
- Rendered the shared-test browser-safe fixture catalog from
  `RALLAR_BLACK_BOX_SHARED_TEST_RECIPE_CATALOG` with search, profile filtering,
  provider mode, live support, badges, prerequisites, expected result, and
  copyable root/direct runner commands.
- Added coverage ownership display from
  `RALLAR_BLACK_BOX_SHARED_TEST_COVERAGE_HANDOFF`.
- Added artifact bundle import for `report.json`, `events.jsonl`,
  `failures.json`, `metadata.json`, optional `expanded-plan.json`, and optional
  `matrix-summary.json`.
- Validated artifact bundles with
  `parseRallarBlackBoxSharedTestArtifactBundle(...)` before display.
- Projected valid artifacts into imported summary, event stream, RTC
  diagnostics, failure-focus, and replay-recipe views.
- Kept shell execution out of the browser; the UI only copies commands.
- Updated app docs and examples guidance for the new `Shared Test` workspace.

Verification:

- `npm --workspace rallar-black-box run typecheck` passed.
- `npx vitest run packages/tests/rallar-black-box/app-tabs.test.ts packages/tests/shared-test/black-box-runner-artifact-reader.test.ts packages/tests/shared-test/black-box-runner-handoff-contract.test.ts`
  passed.
- `npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/tabbed-navigation.spec.ts`
  passed after installing the local Playwright Chromium binary.
- `npm run build:rallar-black-box` passed.
- `npm run check:shared-test` passed.
- `git diff --check` passed for the touched app/shared-test docs and tests.

### Iteration 28: Auth Command Center

Status: completed on 2026-05-28.

Goal: Make auth/session behavior a first-class testing surface.

Work:

- Add an Auth section or tab surface for login, register, restore, logout,
  inspect session, clear session, and copy redacted session diagnostics.
- Add visible `/api/auth/ws-ticket` ticket creation and ticket expiry checks.
- Add negative-case actions for bad credentials, missing token, expired session,
  forbidden user, and CORS/network denial.
- Make auth actions exportable as recipe snippets where they map to HTTP or
  existing runtime commands.
- Add tests for UI auth workflows and redacted exported artifacts.

Exit criteria:

- The SPA can be used to manually and repeatedly test Rallar auth and session
  behavior without dropping into DevTools.

Results:

- Added an `Auth` tab and URL aliases for `login` and `session`.
- Added login, register-and-login, restore-session, logout, clear-local-session,
  WS-ticket creation, bad-credentials, and missing-auth-ticket actions.
- Added visible session context with user, client, session, token presence,
  session expiry, WS-ticket presence, and ticket expiry.
- Added a redacted auth action log and copyable redacted diagnostics.
- Added copyable auth recipe output for login, WS-ticket creation, and missing
  token negative coverage.
- Kept token, ticket, and password values out of visible panel output.

Verification:

- `npm --workspace rallar-black-box run typecheck` passed.
- `npx vitest run packages/tests/rallar-black-box/app-tabs.test.ts` passed.
- `npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/tabbed-navigation.spec.ts`
  passed with mocked auth REST routes and redaction assertions.

### Iteration 29: Rooms And Clients Command Center

Status: completed on 2026-05-28.

Goal: Make rooms/groups, clients, sessions, and presence easy to inspect and
control.

Work:

- Add a Rooms/Clients view or expand the Rallar Server tab with state tables for
  groups, members, clients, instances, sessions, and presence.
- Expose application ID, workspace ID, group ID, principal/client ID, instance
  ID, and session ID as reusable visible variables.
- Add actions for create group, read group, join, leave, connect presence,
  heartbeat, disconnect presence, list group events, list client events, and
  refresh state.
- Add expected-vs-observed membership comparison using live REST state and
  runtime events.
- Add event replay/list-page workflows for rooms and clients.

Exit criteria:

- A tester can verify group membership correctness and client presence from the
  SPA with live server evidence.

Results:

- Added a `Rooms/Clients` tab and URL aliases for `rooms`, `clients`, `people`,
  and `presence`.
- Added reusable visible variables for API base URL, application ID, workspace
  ID, group ID, principal/client ID, client instance ID, session ID, and timeout.
- Added one-click state actions for list groups, list clients, create group,
  read group, join, leave, client connect/heartbeat/disconnect, group
  presence connect/heartbeat/disconnect, group events, group events page, client
  events, client events page, and refresh state.
- Added group, client, and state-event tables from live REST responses.
- Added expected/observed/missing client metrics derived from the runtime RTC
  diagnostics alongside live REST evidence.
- Added copyable state recipe output for group/client setup and event evidence.
- Extended Rallar Server REST presets with client/group event page, client
  disconnect, and group leave endpoints needed by the command-center view.

Verification:

- `npm --workspace rallar-black-box run typecheck` passed.
- `npx vitest run packages/tests/rallar-black-box/app-tabs.test.ts` passed.
- `npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/tabbed-navigation.spec.ts`
  passed with mocked authenticated group, client, and state-event REST routes.
- `npm run build:rallar-black-box` passed.
- `npm run check:shared-test` passed.
- `git diff --check -- apps/rallar-black-box packages/tests/rallar-black-box tests/playwright/rallar-black-box`
  passed.

### Iteration 30: REST Collections, Variables, And Assertions

Status: completed on 2026-05-28.

Goal: Turn the Rallar Server tab from a request sender into a repeatable REST
testing workbench.

Work:

- Add saved request collections and named variables.
- Add response extraction from JSON paths into variables.
- Add expected status/body/header assertions.
- Add multi-request REST recipe generation in the shared black-box-runner
  vocabulary.
- Add negative-case templates for auth, permission, missing group/client, and
  duplicate resource behavior.
- Add import/export for request collections with redaction.

Exit criteria:

- REST API testing can move from one-off clicks to repeatable command-center
  flows that can also become shared-test recipes.

Results:

- Added a `REST Collection` workspace inside the `Rallar Server` tab.
- Added persisted collection JSON and named variables JSON with redacted local
  storage writes.
- Added collection templates for group membership evidence, client presence
  lifecycle, and negative auth/state cases.
- Added variable substitution with `{{name}}` and `${name}` placeholders across
  paths, query, headers, and bodies.
- Added JSON-path response extraction into variables, including body paths,
  headers, and status code.
- Added expected status, body JSON-path, and header assertions with visible
  per-step assertion chips.
- Added `Add Current Request`, `Run Collection`, `Copy Collection`, and
  `Copy Collection Recipe` actions.
- Exported collections as black-box `http.request` recipes with assertion and
  extraction metadata under each command.

Verification:

- `npm --workspace rallar-black-box run typecheck` passed.
- `npx vitest run packages/tests/rallar-black-box/app-tabs.test.ts packages/tests/rallar-black-box/rallar-server-workbench.test.ts`
  passed.
- `npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/tabbed-navigation.spec.ts`
  passed with a mocked REST collection assertion/extraction flow.

### Iteration 31: WebSocket Command Center

Status: completed on 2026-05-28.

Goal: Make WS testing as visible and ergonomic as RTC testing.

Work:

- Add a dedicated WS connection panel with ticket creation, open, send, wait,
  reconnect, close, and cleanup actions.
- Show connection state, ready state, ticket age, close code/reason, inbound
  messages, outbound messages, and errors.
- Add send templates for common Rallar WS payloads/topics.
- Add WS negative flows for missing/expired ticket, unauthorized socket,
  unexpected close, and server restart/reconnect.
- Add WS-vs-RTC parity workflow for the same group, clients, and JSON payload.

Exit criteria:

- A tester can open authenticated WS, send JSON, see received data, and compare
  WS and RTC behavior in the SPA.

Results:

- Added a first-class `WebSocket` tab and URL aliases for `ws`, `socket`,
  `websocket`, and `websockets`.
- Added a dedicated WS command-center panel with configure, ticket creation,
  open, open API WS, send JSON, wait for message, reconnect, close, cleanup,
  missing-ticket negative open, diagnostics copy, WS recipe copy, and WS/RTC
  parity recipe copy actions.
- Added visible WS status for provider, connection name, ready state, inbound
  count, outbound count, error count, wait state, ticket presence/expiry, last
  open, last close, close code, and close reason.
- Added payload presets for ping, group message, and WS/RTC parity probes.
- Follow-up on 2026-05-29: changed the default WebSocket preset to `Group Message - current group`, promoted joined
  groups from Manual Rallar and Rooms/Clients into Global Context, and tightened WebSocket state sync so the tab uses
  the joined/global group unless the WebSocket group field was intentionally changed.
- Follow-up on 2026-05-29: changed Rallar-mode WebSocket send/subscribe/wait actions to call Rallar directly through
  `@shared-web/browser/rallar.ts`; these actions no longer execute black-box-runner `ws.send` commands or use
  `browser-rallar-runtime.ts`. Manual Rallar remains available as a black-box-runner command scratchpad instead of a
  direct Rallar-mode tab.
- Follow-up on 2026-05-29: changed the SPA Rallar WS defaults and presets to server-accepted user topics
  (`room.manual.message`, `app.black-box.ws.ping`, and `room.black-box.transport-check`) and added direct-operation
  validation so invalid topics such as unprefixed `manual.message` fail visibly before a send is reported.
- Follow-up on 2026-05-29: gated local sample replay/bootstrap behind `Rallar black-box-runner` mode and added a
  boundary regression test so direct Rallar panels cannot call black-box runtime command execution APIs.
- Added a recent WS event list with redacted payload display so testers can
  inspect open, inbound, outbound, close, and error evidence without searching
  the global event stream first.
- Added simulated Playwright coverage for configuring, opening, sending, and
  closing through the WebSocket command center.

Verification:

- `npm run build:rallar-black-box` passed.
- `npm --workspace rallar-black-box run typecheck` passed.
- `npx vitest run packages/tests/rallar-black-box/app-tabs.test.ts` passed.
- `npx vitest run packages/tests/rallar-black-box/app-tabs.test.ts packages/tests/rallar-black-box/rallar-server-workbench.test.ts`
  passed.
- `npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/tabbed-navigation.spec.ts`
  passed with simulated WebSocket command-center events.
- `npm run check:shared-test` passed.
- `git diff --check -- apps/rallar-black-box packages/tests/rallar-black-box tests/playwright/rallar-black-box`
  passed.

### Iteration 32: RTC Delivery Matrix And Scoped Addressing

Status: completed on 2026-05-28.

Goal: Make real RTC delivery and failure modes testable from the UI.

Work:

- Expose `applicationId`, `workspaceId`, `scope`, `roomRef`, and
  `minSnapshotVersion` in Manual Rallar/recipes where relevant.
- Surface ready peer IDs, active peer IDs, missing peers, lane health, and
  first-payload latency as live command-center signals.
- Add UI-driven real-provider flows for direct, multicast, and broadcast
  delivery over both `realtime` and `messages.rtc`.
- Add recipes and diagnostics for missing peer, stale agent, duplicate session,
  permission denial, closed transport, and `not-yet-in-sync`/NACK outcomes.
- Add Playwright coverage for at least one multi-agent multicast/broadcast flow.

Exit criteria:

- The SPA can prove real RTC semantics beyond two-agent direct delivery.

Results:

- Added Manual Rallar fields for `applicationId`, `workspaceId`, `scope`,
  `roomRef`, and `minSnapshotVersion`.
- Passed scoped RTC fields through manual `configure`, `rtc.connect`,
  `rtc.send`, group creation, recipe snippets, and browser draft persistence.
- Added a Manual Rallar RTC Delivery Matrix with one-click realtime and
  `messages.rtc` direct, multicast, and broadcast command sets.
- Added copyable RTC matrix and RTC negative recipes covering missing peer,
  stale agent, duplicate session, permission denied, closed transport, and
  `not-yet-in-sync`/NACK probes.
- Added a runnable NACK probe from the Manual Rallar surface.
- Extended simulated RTC events with scoped addressing, ready peer IDs, active
  peer IDs, lane health, delivery mode, targets, and NACK diagnostics.
- Extended RTC Diagnostics to show ready peers, active peers, missing peers,
  lane health, NACK codes, and first-payload latency together.
- Added Vitest coverage for scoped command generation, matrix command
  generation, negative recipe generation, and NACK diagnostics.
- Added Playwright coverage for running realtime and `messages.rtc` matrix
  flows with scoped addressing and verifying peer/NACK diagnostics.

Verification:

- `npm run build:rallar-black-box` passed.
- `npm --workspace rallar-black-box run typecheck` passed.
- `npx vitest run packages/tests/rallar-black-box/manual-workbench.test.ts packages/tests/rallar-black-box/rtc-diagnostics.test.ts packages/tests/rallar-black-box/ui-persistence.test.ts packages/tests/rallar-black-box/app-tabs.test.ts`
  passed.
- `npx vitest run packages/tests/rallar-black-box/manual-workbench.test.ts packages/tests/rallar-black-box/rtc-diagnostics.test.ts`
  passed.
- `npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/tabbed-navigation.spec.ts`
  passed with simulated RTC delivery matrix and NACK diagnostics coverage.
- `npm run check:shared-test` passed.
- `git diff --check -- apps/rallar-black-box packages/tests/rallar-black-box tests/playwright/rallar-black-box`
  passed.

### Iteration 33: Flow Builder For HTTP, WS, And RTC

Status: completed on 2026-05-28.

Goal: Let users compose command-center flows without hand-writing JSON first.

Work:

- Add a flow builder that can chain auth, REST, WS, RTC, assertions, waits, and
  cleanup steps.
- Add variable binding between steps.
- Add "record manual session as flow" from Manual Rallar, Rallar Server, and WS
  panels.
- Add run preview, step status, and per-step expected result editing.
- Export and import the flow as a shared black-box-runner recipe.

Exit criteria:

- A tester can build "login, create group, join, open WS, connect RTC, send,
  verify, cleanup" from the SPA and save it as a repeatable recipe.

Results:

- Added a `Flow Builder` tab and URL aliases for `flow`, `flows`, and
  `builder`.
- Added editable flow templates for auth/REST/WS/RTC smoke and RTC delivery
  matrix flows.
- Added variable substitution for `{{name}}`, `${name}`, and `{name}` syntax,
  including structured object substitution for exact placeholders.
- Added step add buttons for auth login, REST request, WS open/send, RTC
  connect/send, wait, and cleanup.
- Added editable `Variables JSON` and `Flow JSON` panes, import-by-paste,
  normalization, and parse errors.
- Added SPA recipe preview, black-box-runner scenario preview, copy actions,
  and `Run Flow` execution through an inline `recipe.run`.
- Added step status rows with command links, expected result metadata, and
  extraction metadata display.
- Added helper coverage for flow parsing, variable substitution, SPA recipe
  export, runner scenario export, and step insertion.
- Added Playwright coverage for editing variables, appending a wait step, and
  running a simulated command-center flow.

Verification:

- `npm run build:rallar-black-box` passed.
- `npm --workspace rallar-black-box run typecheck` passed.
- `npx vitest run packages/tests/rallar-black-box/flow-builder.test.ts packages/tests/rallar-black-box/app-tabs.test.ts packages/tests/rallar-black-box/manual-workbench.test.ts packages/tests/rallar-black-box/rtc-diagnostics.test.ts`
  passed.
- `npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/tabbed-navigation.spec.ts`
  passed with Flow Builder coverage.
- `npm run check:shared-test` passed.
- `git diff --check -- apps/rallar-black-box packages/tests/rallar-black-box tests/playwright/rallar-black-box`
  passed.

### Iteration 34: Control-server Run Manager

Status: completed on 2026-05-28.

Goal: Make the SPA useful as an orchestrator for multiple browser agents.

Work:

- Add a Run Manager view backed by the control server.
- List runs, agents, connection state, queued commands, completed results,
  heartbeats, stats, reports, and recent events.
- Add enqueue-command UI for selected agents.
- Add run reset/delete endpoints in the control server.
- Add agent grouping and bulk commands for multi-browser tests.
- Add pagination or bounded snapshots for runs with many events/results.

Exit criteria:

- The SPA can command and inspect multiple browser agents from one visible
  command center.

Results:

- Added a `Run Manager` tab and URL aliases for `runs`, `manager`, `control`,
  and `orchestrator`.
- Added a typed SPA control-run-manager helper for control HTTP URL derivation,
  bounded snapshot loading, run/agent/command row derivation, bulk enqueue,
  run reset, and run delete.
- Added a Run Manager UI that lists runs, agents, connection state, queued/
  dispatched/completed commands, results, recent events, reports, and
  heartbeats from bounded control-server snapshots.
- Added ad hoc agent grouping through selected agent rows and bulk command
  enqueue for Health, Stats, Browser Reset, or custom command JSON.
- Added control-server bounded snapshot query parameters for commands,
  results, events, stats, reports, and heartbeats.
- Added `POST /runs/:runId/commands` for selected-agent bulk enqueue.
- Added `POST /runs/:runId/reset` and `DELETE /runs/:runId` for in-memory run
  lifecycle management.
- Updated the control-server OpenAPI document and SPA docs for the new run
  manager path.

Verification:

- `npm run build:rallar-black-box` passed.
- `npm --workspace rallar-black-box run typecheck` passed.
- `cd apps/rallar-black-box-control-server && deno task check` passed.
- `cd apps/rallar-black-box-control-server && deno task test` passed.
- `npx vitest run packages/tests/rallar-black-box/control-run-manager.test.ts packages/tests/rallar-black-box/app-tabs.test.ts`
  passed.
- `npx vitest run packages/tests/rallar-black-box/control-run-manager.test.ts packages/tests/rallar-black-box/app-tabs.test.ts packages/tests/rallar-black-box/flow-builder.test.ts packages/tests/rallar-black-box/manual-workbench.test.ts packages/tests/rallar-black-box/rtc-diagnostics.test.ts`
  passed.
- `npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/tabbed-navigation.spec.ts`
  passed with Run Manager coverage.

### Iteration 35: Artifacts, Report Browsing, And Persistence

Status: completed on 2026-05-28.

Goal: Make command-center output useful after a run ends.

Work:

- Add durable or file-backed storage option for the control server.
- Add redacted report browsing in the SPA for control-server reports and
  shared-test runner artifact bundles.
- Add event/result JSONL export and import.
- Add copyable failure bundles for auth, REST, WS, RTC, room/client state, and
  control-server failures.
- Add retention settings and cleanup commands.
- Decide whether monitor-server ingestion should be integrated here or remain a
  separate backend concern.

Exit criteria:

- Failed runs produce redacted artifacts that can be attached to issues,
  imported into the SPA, or replayed later.

Results:

- Added a control-server artifact builder that exports shared-test-compatible
  `report.json`, `events.jsonl`, `failures.json`, and `metadata.json` files
  from a control run snapshot.
- Added redacted event JSONL, result JSONL, and failure-bundle exports for
  control-server runs.
- Added control-server endpoints for:
  - `GET /runs/:runId/artifacts`
  - `GET /runs/:runId/artifacts/:fileName`
  - `GET /runs/:runId/events.jsonl`
  - `GET /runs/:runId/results.jsonl`
  - `GET /runs/:runId/failure-bundle`
- Added optional file-backed snapshot persistence with
  `RALLAR_BLACK_BOX_STORAGE_DIR`; persisted runs are restored as disconnected
  snapshots on server startup.
- Added `RALLAR_BLACK_BOX_RETENTION_MAX_RUNS` and
  `POST /retention/cleanup` for local run retention cleanup.
- Added Run Manager artifact browsing actions for loading a control-run
  artifact bundle, validating it through the shared-test artifact parser, and
  copying artifact bundles, events JSONL, results JSONL, and failure bundles.
- Updated the control-server OpenAPI document, docs, and examples to describe
  artifact export and storage.
- Decided monitor-server ingestion should remain a separate backend concern for
  now; this iteration keeps the local control server focused on run snapshots
  and attachable artifacts.

Verification:

- `npm run build:rallar-black-box` passed.
- `cd apps/rallar-black-box-control-server && deno task check` passed.
- `cd apps/rallar-black-box-control-server && deno task test` passed.
- `npm --workspace rallar-black-box run typecheck` passed.
- `npx vitest run packages/tests/rallar-black-box/control-run-manager.test.ts packages/tests/rallar-black-box/app-tabs.test.ts`
  passed.
- `npx vitest run packages/tests/rallar-black-box/control-run-manager.test.ts packages/tests/rallar-black-box/app-tabs.test.ts packages/tests/rallar-black-box/flow-builder.test.ts packages/tests/rallar-black-box/manual-workbench.test.ts packages/tests/rallar-black-box/rtc-diagnostics.test.ts`
  passed.
- `npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/tabbed-navigation.spec.ts`
  passed with Run Manager artifact coverage.

### Iteration 36: Full-stack QA Matrix

Status: completed on 2026-05-28.

Goal: Make the command center reliable against real Rallar Server behavior.

Work:

- Expand Playwright full-stack specs for auth command center, rooms/clients
  state, WS command center, REST collections, recipe catalog/artifact import,
  and RTC multicast/broadcast.
- Add negative matrices for bad credentials, missing token, expired ticket,
  forbidden group operation, stale session, duplicate session, missing peer,
  stale agent, CORS denial, and server restart/reconnect.
- Ensure every real-provider test has explicit skip gates and actionable setup
  messages.
- Cross-check SPA reports, control-server snapshots, Rallar Server state
  endpoints, and black-box runner reports.

Exit criteria:

- Command-center regressions are caught at the right layer before live manual
  testing.

Results:

- Added `src/full-stack-qa-matrix.ts` as a documented full-stack QA coverage
  matrix for auth, rooms/clients, WebSocket, REST, recipes/artifacts, RTC,
  control, and resilience.
- Added coverage guard tests so every matrix row has an owning spec, skip gate,
  polarity, and evidence source.
- Added `full-stack-command-center-qa-matrix.spec.ts` for real-provider command
  center cross-checks:
  - bad-login behavior remains on the login surface with visible auth evidence
  - protected Rallar Server state endpoints reject missing access tokens
  - authenticated WS-ticket creation sends bearer auth from the REST workbench
  - WebSocket command-center configure and missing-ticket negative paths remain
    visible
  - Shared Test catalog and artifact import surfaces still load inside the
    full-stack shell
- Extended the control-orchestration full-stack spec to fetch and validate
  control-server artifact bundles after a run.

Verification:

- `npm run test -- packages/tests/rallar-black-box/full-stack-qa-matrix.test.ts`
  passed.
- `npx playwright test --config apps/rallar-black-box/playwright.full-stack.config.ts --list`
  discovered the full-stack QA matrix spec with skip-safe gating.

### Iteration 37: Large-run UX, Accessibility, And Performance

Status: completed on 2026-05-28.

Goal: Keep the SPA usable when runs become long, noisy, or multi-agent.

Work:

- Add event stream virtualization or pagination.
- Add topology sampling, search, and deterministic route summaries.
- Bound in-memory UI rendering for large runs.
- Add explicit loading, disabled, empty, warning, success, and error states
  across tabs.
- Complete keyboard navigation, focus management, labels, contrast, and
  screen-reader-friendly errors.
- Add desktop and narrow viewport QA.

Exit criteria:

- The command center remains usable for long-running and multi-agent tests.

Results:

- Added Event Stream windowing controls for 40, 100, 250, or 500 matching
  events, with a visible status line when older matching events are hidden.
- Kept Event Stream filters accessible through labeled controls and persisted
  filter state across tab changes.
- Added Topology search and node-limit controls so large graphs can be sampled
  without rendering every derived node row.
- Added deterministic route summary metrics for total route commands, RTC
  routes, WS routes, and route failures.
- Tightened responsive CSS so Event Stream filters, topology search controls,
  and topology summaries collapse cleanly on medium and narrow viewports.
- Added simulated Playwright coverage for event-window persistence, topology
  search, topology node limits, and deterministic route summary metrics.

Verification:

- `npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/tabbed-navigation.spec.ts`
  passed and covers the new Event Stream and Topology interactions.

### Iteration 38: Provisioned Live RTC Matrix Baselines

Status: completed on 2026-05-28.

Goal: Capture real green baselines for multicast, broadcast, and NACK behavior
against a provisioned Rallar environment.

Why this is separate:

- Iterations 32 and 33 added SPA controls, recipes, and simulated coverage.
- Green live baselines require a real Rallar Server, signaling path, CORS,
  credentials, at least three browser agents, deterministic cleanup, and a
  stable environment contract.

Work:

- Define required environment variables for API URL, application/workspace,
  room/group IDs, and three users or three restored sessions.
- Add skip-safe Playwright/full-stack specs that launch at least three isolated
  browser contexts.
- Create or isolate a test group per run, join all agents, and verify server
  group/client/presence state before RTC delivery.
- Run direct, multicast, and broadcast over both `realtime` and `messages.rtc`.
- Run negative probes for missing peer, stale agent, closed transport,
  permission denial where supported, and `not-yet-in-sync`/NACK.
- Cross-check UI evidence, RTC Diagnostics, Event Stream, control-server run
  snapshots, and Rallar Server state endpoints.
- Upload or retain redacted artifacts and document the first known-good
  baseline dates/environment.

Exit criteria:

- A provisioned Rallar environment can run the live RTC matrix in one command
  and produce repeatable redacted artifacts for direct, multicast, broadcast,
  and NACK behavior.

Results:

- Added `full-stack-live-rtc-three-browser-matrix.spec.ts`, a skip-safe live
  Playwright baseline that launches three isolated browser contexts in
  `provider=browser-rallar` control-agent mode.
- Added the explicit gate
  `RALLAR_BLACK_BOX_FULL_STACK=1 RALLAR_BLACK_BOX_LIVE_RTC_MATRIX=1` plus
  required API URL, group seed, and three agent credential/restored-session
  variables.
- The live matrix creates a unique group per run, joins all three agents with
  authenticated REST commands, and then runs:
  - realtime direct, multicast, and broadcast delivery
  - `messages.rtc` direct, multicast, and broadcast delivery
  - a high `minSnapshotVersion` not-yet-in-sync/NACK probe
  - a closed-transport stale-send negative check
  - control-server artifact export validation
  - fake-provider topic rejection for live runs
- Added an opt-in all-scenarios live matrix with
  `RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS=1`. It runs REST group readback, WS
  open/send/close from all three agents, every direct sender/receiver pair,
  every sender multicast, every sender broadcast, unexpected-delivery scanning,
  stale-send failure, reconnect-after-stale-agent, and artifact validation.
- Added root command
  `npm run test:e2e:rallar-black-box:full-stack:real:live-rtc-3`.
- Added root command
  `npm run test:e2e:rallar-black-box:full-stack:real:live-rtc-3:all`.
- Added `src/live-rtc-three-browser-coverage.ts` and a Vitest guard so required
  live three-browser coverage stays above 90 percent. Current required coverage
  is 100 percent; total matrix coverage is above 90 percent with explicit
  optional permission-denied coverage left as future work.

Verification:

- `npm run test -- packages/tests/rallar-black-box/live-rtc-three-browser-coverage.test.ts`
  passed.
- `npx playwright test --config apps/rallar-black-box/playwright.full-stack.config.ts --list`
  discovered the live three-browser spec with skip-safe gating.

Verification for Iterations 36-38:

- `npm --workspace rallar-black-box run typecheck` passed.
- `npm run build:rallar-black-box` passed.
- `npm run test -- packages/tests/rallar-black-box/full-stack-qa-matrix.test.ts packages/tests/rallar-black-box/live-rtc-three-browser-coverage.test.ts packages/tests/rallar-black-box/app-tabs.test.ts`
  passed.
- `npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/tabbed-navigation.spec.ts`
  passed.
- `npx playwright test --config apps/rallar-black-box/playwright.full-stack.config.ts --list`
  passed.
- `git diff --check -- apps/rallar-black-box apps/rallar-black-box-control-server packages/tests/rallar-black-box tests/playwright/rallar-black-box package.json`
  passed.

### Iteration 39: Live Permission, Expiry, And CORS Negative Matrix

Status: proposed.

Goal: Close the remaining live negative coverage that needs a deliberately
provisioned Rallar environment.

Work:

- Add stable environment fixtures for denied group operations, forbidden users,
  expired access tokens, expired WS tickets, and disallowed CORS origins.
- Extend full-stack Playwright coverage for Auth, Rooms/Clients, WebSocket, REST
  collections, and Manual Rallar negative cases.
- Convert the optional `permission-denied-negative` live three-browser coverage
  row into required coverage once a fixture contract exists.
- Ensure every denial path produces redacted, copyable failure diagnostics.

Exit criteria:

- Permission, expiry, and CORS regressions fail in automation with actionable
  evidence instead of being discovered manually.

### Iteration 40: Artifact Search, Retention UI, And Run Comparison

Status: proposed.

Goal: Make long-lived command-center output searchable and comparable.

Work:

- Add Run Manager search/filter controls for persisted runs and artifact
  metadata.
- Add artifact retention policy visibility and cleanup previews in the SPA.
- Add compare views for two control-run artifact bundles, focusing on command
  status, failed assertions, event counts, first-failure evidence, and RTC
  latency deltas.
- Keep the control server local-first but make file-backed artifact browsing
  practical for many runs.

Exit criteria:

- A tester can find, prune, and compare saved run artifacts without reading the
  storage directory manually.

### Iteration 41: Live Environment Provisioning And Seed Manager

Status: proposed.

Goal: Make live matrix runs repeatable by defining and validating the Rallar
  environment contract before tests start.

Work:

- Add a seed/provision check that validates application, workspace, group
  prefix, users, permissions, CORS origins, WS support, and RTC transport
  readiness.
- Add a small CLI or control-server endpoint that reports missing live-test
  prerequisites without launching browser agents.
- Document baseline environment names, first-known-good dates, and cleanup
  expectations.
- Generate redacted `.env` examples for one-agent, two-agent, and three-agent
  live matrices.

Exit criteria:

- Live RTC, WS, REST, and negative matrices can fail fast when the environment
  is not provisioned correctly.

### Iteration 42: Runner Catalog Execution Handoff

Status: proposed.

Goal: Connect the visible command center more tightly to shared-test recipes
without turning the browser into a shell executor.

Work:

- Add a control-server mediated "run shared-test recipe" handoff that records
  requested recipe ID, profile, env requirements, and artifact location.
- Show recipe execution status and imported artifacts in the SPA after the
  external runner finishes.
- Support promotion of Flow Builder and Manual Rallar flows into versioned
  shared-test recipe candidates.
- Keep execution explicit, local, and auditable.

Exit criteria:

- A command-center flow can become a shared-test recipe, run through local
  tooling, and return artifacts to the SPA with a clear chain of evidence.

### Iteration 43: Recipe Capability Inventory And Schemas

Status: completed on 2026-05-31.

Goal: Make black-box recipe capabilities explicit, machine-readable, and
usable by the SPA, control server, and shared-test runner.

Work:

- Inventory `rallar-bb-test` command recipes and black-box-runner scenario
  recipes.
- Add capability metadata for command kind, fields, examples, supported
  provider modes, live-service requirements, and artifact expectations.
- Generate JSON Schema for command, recipe, control envelope, black-box-runner
  scenario, and distributed-run manifest shapes.
- Validate app-local recipes, shared-test examples, Flow Builder exports, Run
  Manager command presets, and control-server OpenAPI examples.
- Document schema ownership, compatibility, and versioning.

Exit criteria:

- Invalid recipe JSON fails with actionable schema errors before it is sent to
  a browser agent, control server, or runner.

Results:

- Added `packages/shared-test/rallar-bb-test/schema.ts` with:
  - one capability metadata entry per `rallar-bb-test` command kind
  - provider-mode, runtime-surface, live-service, and artifact-expectation metadata
  - JSON Schema objects for commands, recipes, control command envelopes, and distributed-run manifests
  - browser-safe validation and error-formatting helpers
- Added `packages/shared-test/black-box-runner/schema.ts` for the separate runner scenario format built around
  `variables`, `connections`, and `steps`.
- Exported the schemas and capabilities through `src/shared-test-handoff-fixtures.ts` so command-center UI work can reuse
  the same contract.
- Reused the shared command schema in the control-server OpenAPI document.
- Moved Run Manager command presets into `src/run-manager-presets.ts` and validated edited command JSON against the
  shared command schema before enqueueing it.
- Added schema contract coverage for command capabilities, app-local recipes, shared-test runner examples, Flow Builder
  exports, Manual Rallar snippets, Run Manager presets, control-server OpenAPI command examples, control command
  envelopes, and a distributed-run manifest example.
- Added `packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md` and linked it from app and runner docs.

Verification:

- `npx vitest run packages/tests/shared-test/rallar-bb-test-schema.test.ts` passed.
- `npx vitest run packages/tests/rallar-black-box/control-run-manager.test.ts packages/tests/rallar-black-box/flow-builder.test.ts packages/tests/rallar-black-box/manual-workbench.test.ts packages/tests/shared-test/rallar-bb-test-schema.test.ts`
  passed.
- `npm --workspace @ar-eye-hunter/shared-test run check:ts` passed.
- `npm --workspace @ar-eye-hunter/shared-test run check` passed.
- `npm --workspace rallar-black-box run typecheck` passed.
- `npm run build:rallar-black-box` passed.
- `cd apps/rallar-black-box-control-server && deno task check` passed.
- `cd apps/rallar-black-box-control-server && deno task test` passed.

### Iteration 44: Distributed Run Contract

Status: completed on 2026-05-31.

Goal: Define a first-class distributed recipe test lifecycle on top of the
existing recipe and control-agent contracts.

Work:

- Add a distributed-run manifest with run ID, group reference, selected recipes,
  target policy, participant count, variables, per-agent roles, ACK/readiness
  timeout, start mode, and artifact policy.
- Define distributed states: draft, resolving targets, staging,
  waiting-for-ack, ready, running, passed, failed, cancelled, and timed-out.
- Define per-agent and per-recipe rollup behavior.
- Add JSON Schema for the distributed-run manifest.

Exit criteria:

- A distributed recipe test can be represented as JSON without depending on SPA
  component state.

Results:

- Added `packages/shared-test/rallar-bb-test/distributed-run.ts` with:
  - distributed-run lifecycle states and terminal-state helper
  - target policy modes and start modes
  - manifest, group, recipe-selection, role-assignment, artifact-policy, participant-result, and recipe-result types
  - domain validation for standalone manifests
  - participant/recipe rollup behavior into one distributed-run state
- Expanded `RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA` to match the richer contract, including shared variables,
  secret refs, role assignments, ACK timeout, scheduled-start deadline, and artifact policy.
- Exported distributed-run constants and helpers through `src/shared-test-handoff-fixtures.ts`.
- Added `packages/tests/shared-test/rallar-bb-test-distributed-run.test.ts` for lifecycle, manifest validation, and
  rollup semantics.
- Added `packages/shared-test/rallar-bb-test/docs/distributed-run-contract.md` and linked it from the app docs and schema
  docs.

Verification:

- `npx vitest run packages/tests/shared-test/rallar-bb-test-distributed-run.test.ts packages/tests/shared-test/rallar-bb-test-schema.test.ts`
  passed.
- `npm --workspace @ar-eye-hunter/shared-test run check:ts` passed.
- `npm --workspace @ar-eye-hunter/shared-test run check` passed.
- `npm --workspace rallar-black-box run typecheck` passed.
- `npm run build:rallar-black-box` passed.
- `cd apps/rallar-black-box-control-server && deno task check` passed.
- `git diff --check -- apps/rallar-black-box apps/rallar-black-box-control-server packages/shared-test packages/tests/shared-test packages/tests/rallar-black-box`
  passed.

### Iteration 45: Group Member To Control Agent Mapping

Status: completed on 2026-05-31.

Goal: Let runner-mode tests target members of the current Rallar group instead
of requiring manual agent ID selection.

Work:

- Extend control-agent registration/heartbeat metadata with Rallar identity:
  username/client ID, session ID, application ID, workspace ID, current group,
  provider mode, and browser/session labels.
- Extend control-server snapshots with that identity metadata.
- Resolve current group members from Rallar Server and correlate them with
  connected control agents.
- Show matched, unmatched, offline, stale, and duplicate sessions before a run.
- Add target policies for all online group members, selected matched agents,
  required expected agents, and dry-run target resolution.

Exit criteria:

- The UI can explain exactly which group members will run a recipe and why any
  member is not targetable.

Results:

- Added shared `RallarBlackBoxControlAgentIdentity` metadata for browser control agents.
- Control-agent register and heartbeat envelopes now include current Rallar identity metadata derived from runtime config:
  principal/client/username, session, client instance, application, workspace, group, provider mode, browser label,
  session label, and update time.
- Control-server agent snapshots now store the latest identity metadata, expose it through snapshots, and preserve it
  through snapshot restore.
- Control-server OpenAPI now documents `ControlAgentIdentity` on agent snapshots and heartbeat envelopes.
- Run Manager agent rows expose identity metadata and show a compact identity summary for connected agents.
- Added shared matching helpers in `packages/shared-test/rallar-bb-test/distributed-run.ts`:
  - `resolveGroupMemberControlAgentMatches(...)`
  - `resolveDistributedTargetAgentIds(...)`
- Matching now explains `matched`, `unmatched-group-member`, `offline-agent`, `stale-agent`, `duplicate-session`,
  `agent-without-group-member`, and `agent-without-identity` cases before a distributed run is staged.
- Target-policy filtering only returns targetable matched agents for `all-online-group-members`, `selected-agents`, and
  `role-map`.
- Updated distributed-run docs with the identity and target-resolution contract.

Verification:

- `npx vitest run packages/tests/shared-test/rallar-bb-test-distributed-run.test.ts packages/tests/rallar-black-box/control-client.test.ts packages/tests/rallar-black-box/control-run-manager.test.ts`
  passed.
- `cd apps/rallar-black-box-control-server && deno task test` passed.
- `npm --workspace @ar-eye-hunter/shared-test run check:ts` passed.
- `npm --workspace @ar-eye-hunter/shared-test run check` passed.
- `npm --workspace rallar-black-box run typecheck` passed.
- `cd apps/rallar-black-box-control-server && deno task check` passed.

### Iteration 46: Control Server Distributed Orchestrator

Status: completed on 2026-05-31.

Goal: Move distributed-run staging, ACK/readiness, start, cancel, and export
logic into the control server.

Work:

- Add distributed-run endpoints for create/list/read/stage/start/cancel/export.
- Stage recipes by enqueueing load/preflight commands to target agents.
- Treat ACK/readiness as explicit command results.
- Start agents via scheduled `deadlineEpochMs` or an explicit distributed start
  command if needed.
- Persist distributed-run state with links to underlying control-run commands,
  results, events, reports, and artifacts.
- Keep existing `/runs` endpoints compatible.

Exit criteria:

- A distributed run can be staged, started, cancelled, monitored, and exported
  through server APIs.

Results:

- Added first-class distributed-run state to the control server, linked to the
  existing lower-level control-run commands/results/events.
- Added APIs for create/list/read/stage/start/cancel/export under
  `/distributed-runs`.
- Staging queues `recipe.load` for inline recipes or `health` preflight for
  recipe references; stage ACK/readiness is derived from command results.
- Expected participant count mismatches fail before commands are queued, and
  `ackTimeoutMs` rolls up missing ACKs to `timed-out`.
- Start queues `recipe.run` and uses `startDeadlineEpochMs` as the command
  deadline for scheduled manifests.
- Cancel queues `recipe.cancel` for target agents and marks the distributed run
  terminal.
- Target resolution supports selected agents, role maps, and online agents whose
  reported Rallar identity matches the manifest group.
- Snapshots and artifact bundles expose target agents, command links, rollup
  state, failures, manifest JSON, distributed-run JSON, and the linked
  control-run JSON.
- OpenAPI documents the new distributed-run endpoints and schemas.

Verification:

- `cd apps/rallar-black-box-control-server && deno task check` passed.
- `cd apps/rallar-black-box-control-server && deno task test` passed.
- `npx vitest run packages/tests/shared-test/rallar-bb-test-schema.test.ts`
  passed.

### Iteration 47: Distributed Recipes UI

Status: completed on 2026-05-31.

Goal: Add a user-friendly runner-mode surface for choosing preconfigured
recipes and executing them across browser agents.

Work:

- Add a `Distributed Recipes` tab or runner-mode subpanel.
- Show catalog recipes with multi-select, profile filters, live/offline badges,
  prerequisites, and schema validity.
- Show Global Context group and target resolution status.
- Show target agents as matched, connected, ready, running, passed, failed,
  stale, or offline.
- Add Resolve targets, Stage, Start, Cancel, Refresh, and Export artifact
  actions.
- Add role assignment for all-agents, sender/receiver, one-sender-many-receiver,
  and three-browser matrix patterns.

Exit criteria:

- A user can choose recipes, stage them, start them across group browsers, and
  understand progress without editing raw command JSON.

Results:

- Added the `Distributed Recipes` runner-mode tab.
- Added typed SPA control-server helpers for distributed-run list/read/create,
  stage, start, cancel, and artifact export.
- Added app-local browser-agent recipe catalog selection with search, profile
  filters, live-traffic badges, prerequisites, and schema validation badges.
- Added Global Context group target resolution against selected control-run
  agents with matched, stale, offline, different-group, and missing-identity
  states.
- Added target policy, ACK timeout, start mode, role-pattern, distributed-run ID,
  manifest preview, create, stage, start, cancel, refresh, resolve-targets,
  export-artifact, and copy-artifact controls.
- Added distributed-run summaries for state, target count, command links,
  readiness, passed recipes, blocking failures, and artifact metadata.

Verification:

- `npm --workspace rallar-black-box run typecheck` passed.
- `npx vitest run packages/tests/rallar-black-box/app-tabs.test.ts packages/tests/rallar-black-box/rallar-mode-boundary.test.ts packages/tests/rallar-black-box/control-run-manager.test.ts packages/tests/rallar-black-box/distributed-recipes.test.ts`
  passed.
- `npm run build:rallar-black-box` passed.

### Iteration 48: Live Monitoring And Historical Distributed Runs

Status: completed on 2026-05-31.

Goal: Make ongoing and previous distributed recipe tests inspectable from the
SPA.

Work:

- Add timeline, per-agent progress, per-recipe progress, ACK table, failure
  focus, filtered event stream, latency summaries, and artifact validation.
- Add historical distributed-run filters by group, recipe, profile, user,
  status, date, and failure type.
- Add comparison for two distributed runs with participant, failure, timing, and
  received-message deltas.
- Reuse control-run artifact bundles and add distributed-run metadata as an
  optional artifact file.

Exit criteria:

- Ongoing and historical distributed tests can be reviewed with enough evidence
  to reproduce failures.

Results:

- Added distributed-run monitor helpers for lifecycle timelines, command/result
  counts, per-agent progress, per-recipe progress, ACK readiness, failure focus,
  filtered events, latency summaries, artifact validation, history filtering,
  and two-run comparison.
- Added a `Distributed Recipes` monitor panel with failures first, ACK rows,
  agent/recipe progress, linked event stream, timeline, latency metrics, and
  artifact status.
- Added historical distributed-run filters for group, recipe, profile, user,
  status, date, failure type, and search text.
- Added two-run comparison for recipe/profile changes, participant deltas,
  failure deltas, timing deltas, and received-message deltas.

Verification:

- `npx vitest run packages/tests/rallar-black-box/app-tabs.test.ts packages/tests/rallar-black-box/rallar-mode-boundary.test.ts packages/tests/rallar-black-box/control-run-manager.test.ts packages/tests/rallar-black-box/distributed-recipes.test.ts`
  passed.
- `npm --workspace rallar-black-box run typecheck` passed.
- `npm run build:rallar-black-box` passed.

### Iteration 49: Schema-Driven Authoring And Validation UI

Status: completed on 2026-05-31.

Goal: Use generated JSON Schema to make recipe editing and distributed-run
configuration safer.

Work:

- Validate Local Workbench recipes, Manual Rallar exports, Flow Builder exports,
  Run Manager command JSON, and Distributed Run manifests in the browser.
- Show schema errors next to the relevant JSON editor.
- Add generated examples/snippets for each command kind.
- Show capability help for provider mode, live-service prerequisites, expected
  artifacts, and distributed compatibility.

Exit criteria:

- Humans and AI assistants can author/edit recipes in the UI with immediate
  validation and capability guidance.

Results:

- Added `src/schema-authoring.ts` for shared browser-side validation of command
  JSON, browser-agent recipes, distributed-run manifests, and runner scenarios.
- Local Workbench validates recipe JSON and manual command JSON next to the
  editors, blocks invalid load/execute actions, and exposes generated command
  examples.
- Manual Rallar validates generated preview/export recipes, including delivery
  matrix and negative recipe exports.
- Run Manager validates command JSON before enqueue and shows command example
  snippets plus capability metadata.
- Flow Builder validates SPA recipe and black-box-runner scenario exports.
- Distributed Recipes validates manifest previews and shows capability details
  in catalog rows.
- Capability help includes provider modes, runtime surfaces, live-service
  requirements, artifact expectations, and distributed compatibility.

Verification:

- `npx vitest run packages/tests/rallar-black-box/schema-authoring.test.ts packages/tests/rallar-black-box/app-tabs.test.ts packages/tests/rallar-black-box/rallar-mode-boundary.test.ts packages/tests/rallar-black-box/control-run-manager.test.ts packages/tests/rallar-black-box/distributed-recipes.test.ts`
  passed.
- `npm --workspace rallar-black-box run typecheck` passed.
- `npm run build:rallar-black-box` passed.

### Iteration 50: Full-Stack Distributed Recipe QA

Status: completed on 2026-05-31.

Goal: Prove distributed recipe execution with real browser agents and real
data.

Work:

- Add skip-safe Playwright tests with at least three browser contexts connected
  as control agents.
- Create/join a real Rallar group and resolve targets from that group.
- Execute an all-agent ACK recipe, a sender/receiver WS recipe, and a small
  RTC/realtime recipe.
- Add negative tests for missing agent, schema failure, ACK timeout,
  disconnect-after-stage, and one-agent recipe failure rollup.
- Verify distributed-run artifact export and historical-run display.

Exit criteria:

- Distributed recipe execution has full-stack coverage and produces reproducible
  redacted artifacts.

Results:

- Added `full-stack-distributed-recipes.spec.ts`, covering the distributed-run
  API and SPA evidence path with three browser control agents.
- The simulated full-stack path now proves group identity target resolution,
  all-agent ACK staging/start, distributed artifact export, and historical-run
  display.
- Added negative coverage for invalid manifest schema, missing expected target
  count, ACK timeout, disconnect-after-stage, and one-agent recipe failure
  rollup.
- Added an opt-in live path gated by
  `RALLAR_BLACK_BOX_DISTRIBUTED_RECIPES=1`. It creates and joins a real Rallar
  group, runs group-target ACK, sends WS data and verifies receiving browsers,
  then connects RTC and verifies realtime delivery.
- Added a default third live user (`charlie/secret`) for local API-v1 fixture
  runs, so the distributed root command can execute the live browser test
  instead of skipping because agent C auth is absent.
- Changed the live distributed WS recipe to use a server-accepted `room.*`
  user topic and resolved auth placeholders before browser-Rallar `ws.send`,
  avoiding reserved `rallar.*` topic rejection during real fanout.
- Fixed the live event matcher so browser `kind: "message"` events are matched
  before diagnostic payload unwrapping.
- Aligned control-protocol validation with scoped RTC command fields used by
  distributed recipes.
- Control-agent bootstrap now accepts application/workspace defaults and
  `heartbeatIntervalMs`, making reported group identity immediate enough for
  distributed target resolution.
- Added `npm run test:e2e:rallar-black-box:full-stack:real:distributed`.
- Added `docs/distributed-recipe-full-stack-qa.md`.

Verification:

- `npm --workspace rallar-black-box run typecheck` passed.
- `npx vitest run packages/tests/rallar-black-box/control-bootstrap.test.ts packages/tests/rallar-black-box/distributed-recipes.test.ts`
  passed.
- `npx vitest run packages/tests/shared-test/rallar-bb-browser-adapter-auth.test.ts packages/tests/shared-test/rallar-bb-test.test.ts packages/tests/rallar-black-box/control-bootstrap.test.ts packages/tests/rallar-black-box/distributed-recipes.test.ts`
  passed.
- `deno test apps/rallar-black-box-control-server/test/control-service.test.ts`
  passed.
- `npm run test:e2e:rallar-black-box:full-stack:real:distributed` passed with
  live three-browser ACK, WS receive, RTC connect, and realtime send enabled.
- `npx playwright test --config apps/rallar-black-box/playwright.full-stack.config.ts --list`
  passed.

## Review After Iteration 38

The existing command-center iteration list is still the right product roadmap.
Iterations 26 through 38 are complete. Shared-test Iterations 16-19 reduced the
risk in Iteration 27 by providing stable catalog/artifact/coverage contracts,
live RTC baseline entries, artifact parsers, versioned fixtures, and
compatibility rules that the SPA now renders and reuses. Iterations 28-32 made
auth, rooms/clients, REST, WS, and RTC first-class command-center surfaces.
Iterations 33-35 added flow composition, multi-agent control orchestration, and
control-run artifact export. Iteration 36 added full-stack coverage ownership,
Iteration 37 bounded the largest visible event/topology rendering surfaces, and
Iteration 38 added the first skip-safe three-browser live RTC matrix baseline
with explicit coverage accounting.

Iterations 43 through 50 are now complete for group-aware distributed recipe
execution. They build on existing Shared Test catalog display, Run Manager bulk
enqueue, control-agent orchestration, and artifact export, and now include
schema-backed recipe validation, a distributed-run manifest, group member to
control-agent mapping, explicit ACK/readiness, distributed-run server APIs, a
user-friendly Distributed Recipes UI, historical distributed-run monitoring,
schema-driven authoring, and skip-safe full-stack coverage.

The main remaining risk is integration, not contract design:

- the SPA still needs full matrix loading and large multi-run artifact browsing
- distributed recipe execution now has the shared contract, target matching,
  server orchestration APIs, first user-facing UI, historical monitoring, and
  full-stack coverage; remaining work is mostly retention, saved filters,
  large-run browsing, and provisioned negative live fixtures
- the control server still needs retention policy, artifact search, and deeper
  durable storage decisions
- live permission, expiry, forbidden, CORS, and server-restart cases need
  provisioned negative fixtures
- exact server-provided NACK semantics should be tightened once the provisioned
  environment exposes a stable denial/NACK contract
- live environment provisioning should be checked before long browser matrices
  launch

## Recommended Next Step

Start with Iteration 39 if following the original plan order. If the priority is
distributed recipe execution from the UI, continue with Iteration 48 now that
Iterations 43 through 47 have added the schema/capability foundation, the
distributed-run contract, group-member to control-agent target matching,
server-owned lifecycle orchestration, and the first Distributed Recipes UI.

Reasoning:

- Iterations 28 and 29 now provide first-class auth/session and rooms/clients
  command-center surfaces.
- Iteration 30 now gives the REST workbench repeatable collections, variables,
  extraction, assertions, and recipe export.
- Iteration 31 now makes WS testing visible in the SPA.
- Iteration 32 now expands real RTC delivery semantics, scoped addressing,
  multicast/broadcast behavior, and NACK visibility.
- Iteration 33 now composes auth, REST, WS, RTC, assertions, waits, and cleanup
  into reusable flows without hand-writing JSON.
- Iteration 34 now makes multi-agent command-center orchestration visible from
  the SPA through the control server.
- Iteration 35 now makes failed control runs exportable as redacted,
  attachable artifacts.
- Iteration 36 now gives full-stack command-center coverage an explicit owner
  matrix.
- Iteration 37 now bounds the main large-run UI surfaces for event and topology
  browsing.
- Iteration 38 now gives live three-browser RTC coverage a runnable baseline
  and a coverage guard above 90 percent.
- Iteration 39 should follow if the next priority is hardening real negative
  cases. Choose Iteration 40 instead when artifact operations and saved run
  comparison become the workflow bottleneck.
- Iteration 43 is complete. It prevents the later distributed UI and
  orchestration work from relying on loosely validated JSON.
- Iteration 44 is complete. The manifest and lifecycle contract are stable
  enough for server orchestration and UI controls to build on.
- Iteration 45 is complete. The SPA/control server now have a reliable way to
  map current Rallar group members to connected browser control agents.
- Iteration 46 is complete. The control server owns distributed-run lifecycle
  orchestration.
- Iteration 47 is complete. The next distributed-recipe step is Iteration 48:
  add deeper live monitoring and historical distributed-run browsing.
