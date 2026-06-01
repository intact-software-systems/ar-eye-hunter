# Distributed Recipe Execution Iterations

This document describes the gap between the current black-box-runner UI and a user-friendly distributed recipe test
workflow.

## Current State

The requested workflow is now substantially implemented in the command center, with remaining work focused on authoring
guidance, full-stack QA, retention, saved filters, and large-run performance.

What exists:

- `Shared Test` shows preconfigured app-local and shared-test recipe catalogs.
- `Shared Test` can copy recipe paths and runner commands, and it can import artifact bundles after external execution.
- `Run Manager` can talk to `apps/rallar-black-box-control-server`, list runs, list connected control agents, enqueue a
  command to selected agents, show recent results/events, and export artifacts.
- The control server has `/runs/{runId}/commands` for bulk command queueing and stores agents, queued commands, results,
  events, reports, heartbeats, and artifacts.
- The control server has distributed-run APIs for create/list/read/stage/start/cancel/export over the existing control
  run command/result store.
- Distributed-run staging now queues `recipe.load` for inline recipes or a `health` preflight for recipe references, and
  readiness is derived from command results.
- The `Distributed Recipes` tab can create manifests, resolve targets from the selected control run and Global Context
  group, stage, start, cancel, refresh, and export distributed runs.
- The catalog includes a configurable `rtc-realtime` browser-agent recipe for 20 Hz RTC position payload streams against
  the current Global Context group. The recipe uses one compact `loop` command for the frame stream and the catalog
  shows the effective frame count.
- Automatic target selection from the current Rallar group exists server-side and is exposed in the SPA for online
  control agents that report matching identity.
- The `Distributed Recipes` tab now includes a monitor view with lifecycle timeline, per-agent progress,
  per-recipe progress, ACK readiness, failure focus, filtered events, command/result counts, latency summaries, and
  artifact validation.
- Historical browsing now has distributed-run filters for group, recipe, profile, user, status, date, failure type, and
  free-text search, plus a compare view for two distributed runs.

What does not exist yet:

- Retention policy UI, saved filters, and large-run virtualization are still planned.

The right direction is to build on the control server and shared-test catalog. The browser should not become a shell
executor and should not reimplement black-box-runner. The SPA should orchestrate connected browser agents through the
control server and show evidence.

## User-Friendly Target Workflow

In `Rallar black-box-runner` mode, add a `Distributed Recipes` surface:

1. Select current Rallar group from Global Context.
2. Resolve online group members and matching connected browser control agents.
3. Pick one or more preconfigured recipes from the catalog.
4. Review prerequisites, variables, per-agent role assignment, and expected participant count.
5. Click `Stage`.
6. Each target browser receives the recipe bundle, validates it, and returns an ACK/readiness result.
7. Click `Start`, or auto-start once every required agent is ready.
8. All target browsers run the staged recipe or assigned recipe slice.
9. The UI shows live progress by recipe, agent, command, event, failure, and timing.
10. The UI stores a historical distributed-run record with exportable artifacts.

## JSON Schema Strategy

A JSON schema is worth doing before the distributed UI becomes complex. There are two related recipe contracts:

- `rallar-bb-test` command recipes used by the SPA/control agents: `configure`, `recipe.load`, `recipe.run`,
  `recipe.cancel`, `rtc.connect`, `rtc.send`, `ws.open`, `ws.send`, `ws.close`, `http.request`, `health`, `stats`,
  `close`, and `reset`.
- `black-box-runner` scenario recipes used by the shared-test runner CLI and matrix.

Recommended approach:

- Treat `packages/shared-test/rallar-bb-test/types.ts` and the black-box-runner recipe parser/capability set as source
  material, but do not rely on TypeScript types alone as the long-term schema source.
- Introduce explicit capability metadata in `packages/shared-test`: command kind, required fields, optional fields,
  field types, descriptions, examples, and whether the command can run in a browser, remote browser, control server, or
  external runner.
- Generate JSON Schema from that capability metadata.
- Validate every app-local recipe, selected shared-test examples, Run Manager command presets, Flow Builder output, and
  control-server OpenAPI command examples against the schema.
- Expose schemas as files and optionally through the control server:
  - `packages/shared-test/rallar-bb-test/schemas/rallar-bb-test-recipe.schema.json`
  - `packages/shared-test/rallar-bb-test/schemas/rallar-bb-test-command.schema.json`
  - `packages/shared-test/black-box-runner/schemas/black-box-runner-recipe.schema.json`
  - `apps/rallar-black-box-control-server` `/schemas/...` read endpoints
- Use the same schema in the SPA for validation messages, editor hints, and recipe preflight.

Avoid a schema that simply mirrors Rallar facade internals. The schema should describe observable black-box network
operations, expectations, variables, roles, artifacts, and orchestration metadata.

## Iteration 43: Recipe Capability Inventory And Schemas

Status: completed on 2026-05-31.

Goal: Make recipe capabilities explicit and machine-readable before adding distributed orchestration.

Work:

- Inventory all `rallar-bb-test` command kinds and black-box-runner recipe features used by examples.
- Add capability metadata for command kind, fields, examples, browser support, remote-browser support, live-service
  requirements, and artifact expectations.
- Generate JSON Schema for `RallarBlackBoxTestCommand`, `RallarBlackBoxTestRecipe`, control command envelopes, and
  black-box-runner scenario recipes.
- Add validation tests for app-local recipes, shared-test example recipes, Flow Builder exports, Run Manager presets,
  and control-server OpenAPI examples.
- Document schema ownership and compatibility rules.

Exit criteria:

- Invalid recipe JSON fails with actionable schema errors before it is sent to an agent or runner.

Results:

- Added `packages/shared-test/rallar-bb-test/schema.ts` with command capability metadata, schema catalog, browser-safe
  validation helpers, and JSON Schema objects for command, recipe, control command envelope, and distributed-run
  manifest shapes.
- Added `packages/shared-test/black-box-runner/schema.ts` with a separate provider-neutral runner scenario schema for
  the `variables`, `connections`, and `steps` recipe format.
- Exported schemas and capabilities through the SPA shared-test handoff module for future UI validation, catalog badges,
  and distributed-run authoring.
- Reused the shared command schema in the control-server OpenAPI document.
- Moved Run Manager command presets into a separately importable module and validated command JSON against the shared
  schema before enqueueing.
- Added automated validation for app-local recipes, local recipe fixtures, Flow Builder exports, Manual Rallar snippets,
  Run Manager presets, all shared-test runner examples, control-server OpenAPI examples, control command envelopes, and a
  distributed-run manifest example.
- Documented schema ownership, compatibility rules, and the boundary between browser-agent recipes and runner scenarios.

Verification:

- `npx vitest run packages/tests/shared-test/rallar-bb-test-schema.test.ts` passed.
- `npx vitest run packages/tests/rallar-black-box/control-run-manager.test.ts packages/tests/rallar-black-box/flow-builder.test.ts packages/tests/rallar-black-box/manual-workbench.test.ts packages/tests/shared-test/rallar-bb-test-schema.test.ts` passed.
- `npm --workspace @ar-eye-hunter/shared-test run check:ts` passed.
- `npm --workspace @ar-eye-hunter/shared-test run check` passed.
- `npm --workspace rallar-black-box run typecheck` passed.
- `npm run build:rallar-black-box` passed.
- `cd apps/rallar-black-box-control-server && deno task check` passed.
- `cd apps/rallar-black-box-control-server && deno task test` passed.

## Iteration 44: Distributed Run Contract

Status: completed on 2026-05-31.

Goal: Define a first-class distributed-run manifest without changing the lower-level recipe format.

Work:

- Add a `DistributedRecipeRun` manifest shape:
  - run ID
  - group reference
  - selected recipe IDs or inline recipes
  - target policy such as `all-online-group-members`, `selected-agents`, or `role-map`
  - expected participant count
  - variables and secret references
  - per-agent role assignment
  - ACK/readiness timeout
  - start mode: manual, auto-after-ready, or scheduled deadline
  - artifact/retention policy
- Add JSON Schema for the distributed-run manifest.
- Define result states: `draft`, `resolving-targets`, `staging`, `waiting-for-ack`, `ready`, `running`, `passed`,
  `failed`, `cancelled`, `timed-out`.
- Define how failures roll up from per-agent recipe results into one distributed-run result.

Exit criteria:

- A distributed test can be represented as JSON independent of the SPA components.

Results:

- Added `packages/shared-test/rallar-bb-test/distributed-run.ts` with the first-class distributed-run manifest contract,
  target policy modes, start modes, lifecycle states, terminal-state helper, participant/recipe result shapes, domain
  validation, and rollup behavior.
- Expanded `RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA` so it covers schema version, control-run linkage, shared
  variables, secret refs, recipe refs or inline recipes, role assignments, target policy, ACK timeout, start mode, start
  deadline, and artifact policy.
- Exported distributed-run helpers through the SPA shared-test handoff module for later UI and control-server slices.
- Added contract tests for lifecycle states, valid manifests, invalid standalone manifests, scheduled/role-map
  validation, participant readiness, running/passed rollups, optional failures, required failures, timeouts, and
  cancellations.
- Added `packages/shared-test/rallar-bb-test/docs/distributed-run-contract.md`.

Verification:

- `npx vitest run packages/tests/shared-test/rallar-bb-test-distributed-run.test.ts packages/tests/shared-test/rallar-bb-test-schema.test.ts` passed.
- `npm --workspace @ar-eye-hunter/shared-test run check:ts` passed.
- `npm --workspace @ar-eye-hunter/shared-test run check` passed.
- `npm --workspace rallar-black-box run typecheck` passed.
- `npm run build:rallar-black-box` passed.
- `cd apps/rallar-black-box-control-server && deno task check` passed.
- `git diff --check -- apps/rallar-black-box apps/rallar-black-box-control-server packages/shared-test packages/tests/shared-test packages/tests/rallar-black-box` passed.

## Iteration 45: Group Member To Control Agent Mapping

Status: completed on 2026-05-31.

Goal: Safely target "members of the current group" instead of manually selecting agent IDs.

Work:

- Extend control-agent registration/heartbeat metadata with Rallar identity:
  - username/client ID
  - session ID
  - application ID
  - workspace ID
  - current group ID
  - provider mode
  - browser/session labels
- Add control-server snapshot fields for this identity metadata.
- In the SPA, resolve current group members from Rallar Server and correlate them with connected control agents.
- Show matched, unmatched, offline, stale, and duplicate sessions before execution.
- Add user controls for target policy:
  - all online matched agents
  - selected matched agents
  - include offline expected agents as required failures
  - dry-run target resolution only

Exit criteria:

- The UI can explain exactly which group members will run the recipe and why any member is not targetable.

Results:

- Added `RallarBlackBoxControlAgentIdentity` to the shared distributed-run contract.
- Control agents now report Rallar identity metadata on register and heartbeat:
  principal/client/username, session, client instance, application, workspace, group, provider mode, browser label,
  session label, and update time.
- The control server stores the latest identity on agent snapshots and preserves it through snapshot persistence/restore.
- The control-server OpenAPI document now exposes `ControlAgentIdentity` on agent snapshots and heartbeat envelopes.
- Run Manager agent rows now carry identity metadata and show a compact identity summary when available.
- Added shared target-resolution helpers:
  - `resolveGroupMemberControlAgentMatches(...)`
  - `resolveDistributedTargetAgentIds(...)`
- The matcher explains matched, unmatched, offline, stale, duplicate-session, agent-without-member, and
  agent-without-identity cases.
- Added tests for control-client identity registration, control-server identity storage, Run Manager identity summaries,
  group-member matching, and target-policy filtering.

Verification:

- `npx vitest run packages/tests/shared-test/rallar-bb-test-distributed-run.test.ts packages/tests/rallar-black-box/control-client.test.ts packages/tests/rallar-black-box/control-run-manager.test.ts` passed.
- `cd apps/rallar-black-box-control-server && deno task test` passed.
- `npm --workspace @ar-eye-hunter/shared-test run check:ts` passed.
- `npm --workspace @ar-eye-hunter/shared-test run check` passed.
- `npm --workspace rallar-black-box run typecheck` passed.
- `cd apps/rallar-black-box-control-server && deno task check` passed.

## Iteration 46: Control Server Distributed Orchestrator

Status: completed on 2026-05-31.

Goal: Move distributed-run lifecycle management into the control server, not the SPA.

Work:

- Add control-server endpoints:
  - `POST /distributed-runs`
  - `GET /distributed-runs`
  - `GET /distributed-runs/{distributedRunId}`
  - `POST /distributed-runs/{distributedRunId}/stage`
  - `POST /distributed-runs/{distributedRunId}/start`
  - `POST /distributed-runs/{distributedRunId}/cancel`
  - `GET /distributed-runs/{distributedRunId}/artifacts`
- Implement staging by enqueueing `recipe.load` or `recipe.run` preflight commands to target agents.
- Treat agent ACK as an explicit command result, not as an inferred WebSocket send success.
- Support scheduled start via `deadlineEpochMs` or a lightweight `distributed.start` command if needed.
- Persist distributed-run state with links to underlying control-run commands/results/events.
- Keep existing `/runs` endpoints compatible.

Exit criteria:

- A distributed run can be staged, started, cancelled, monitored, and exported through server APIs.

Results:

- Added distributed-run storage and lifecycle methods to `apps/rallar-black-box-control-server/src/control-service.ts`.
- Added server APIs:
  - `POST /distributed-runs`
  - `GET /distributed-runs`
  - `GET /distributed-runs/{distributedRunId}`
  - `POST /distributed-runs/{distributedRunId}/stage`
  - `POST /distributed-runs/{distributedRunId}/start`
  - `POST /distributed-runs/{distributedRunId}/cancel`
  - `GET /distributed-runs/{distributedRunId}/artifacts`
- Staging now targets selected agents, role-map agents, or online agents with matching Rallar identity for
  `all-online-group-members`.
- Expected participant count mismatches fail the distributed run before commands are queued.
- Stage commands use `recipe.load` for inline recipes and `health` preflight for recipe references; ACK/readiness is
  derived from command results.
- `ackTimeoutMs` is enforced from the staged timestamp and rolls up to `timed-out` when required agents do not ACK.
- Manifests can opt into a `barrier` phase after stage ACKs. The control server queues one linked `health` command per
  target as `barrier.ready` evidence, times out missing agents, fails disconnects while waiting, and uses barrier
  completion before auto or scheduled starts.
- Start commands use `recipe.run` and pass scheduled `startDeadlineEpochMs` through as command deadline.
- Cancel queues `recipe.cancel` and marks the distributed run terminal.
- Distributed snapshots include target agents, command links, rollup status, failures, and artifact JSON files linking
  the distributed run back to the underlying control run.
- The existing `/runs` endpoints remain compatible and now include optional `distributedRuns` in the server snapshot.
- Control-server OpenAPI now documents distributed-run endpoints, manifest schema, snapshots, rollups, command links,
  and artifact bundles.

Verification:

- `cd apps/rallar-black-box-control-server && deno task check` passed.
- `cd apps/rallar-black-box-control-server && deno task test` passed.
- `npx vitest run packages/tests/shared-test/rallar-bb-test-schema.test.ts` passed.

## Iteration 47: Distributed Recipes UI

Status: completed on 2026-05-31.

Goal: Make distributed recipe execution easy from `Rallar black-box-runner` mode.

Work:

- Add a `Distributed Recipes` tab or subpanel in runner mode.
- Show recipe catalog with multi-select, profile filters, live/offline badges, prerequisites, and schema validity.
- Show current Global Context group and a target resolution panel.
- Show target agents with clear states: matched, connected, ready, running, passed, failed, stale, offline.
- Add `Resolve targets`, `Stage`, `Start`, `Cancel`, `Refresh`, and `Export artifact` actions.
- Add role assignment for common patterns:
  - all agents same recipe
  - sender/receiver pair
  - one sender, many receivers
  - three-browser matrix roles
- Make dangerous actions explicit when live Rallar data or real RTC is involved.

Exit criteria:

- A user can choose recipes, see target browsers, stage the run, start it, and understand current progress without
  editing raw command JSON.

Results:

- Added a `Distributed Recipes` tab to `Rallar black-box-runner` mode with URL aliases and keyboard tab order.
- Added typed SPA helpers for distributed-run control-server APIs: list, read, create, stage, start, cancel, and artifact
  export.
- Added a browser-agent recipe catalog based on existing app-local `rallar-bb-test` recipe fixtures with multi-select,
  search, profile filtering, live-traffic badges, prerequisites, and schema-validity badges.
- Added target resolution from selected control run agents and Global Context group with matched, offline, stale,
  different-group, and missing-identity states.
- Added role-pattern controls for all-agents, sender/receiver, one-sender-many-receivers, and three-browser matrix
  manifests.
- Added manifest preview and validation against the shared distributed-run manifest schema plus contract validator.
- Added create, stage, start, cancel, refresh, resolve targets, export artifact, and copy artifact actions.
- Added distributed-run list and summary cards showing state, target counts, command links, readiness, passed recipes,
  failures, and loaded artifact metadata.

Verification:

- `npm --workspace rallar-black-box run typecheck` passed.
- `npx vitest run packages/tests/rallar-black-box/app-tabs.test.ts packages/tests/rallar-black-box/rallar-mode-boundary.test.ts packages/tests/rallar-black-box/control-run-manager.test.ts packages/tests/rallar-black-box/distributed-recipes.test.ts` passed.
- `npm run build:rallar-black-box` passed.

## Iteration 48: Live Monitoring And Historical Runs

Status: completed on 2026-05-31.

Goal: Make ongoing and historical distributed tests inspectable without reading raw artifacts.

Work:

- Add a distributed-run monitor with:
  - timeline
  - per-agent progress
  - per-recipe progress
  - ACK/readiness table
  - failures first
  - event stream filtered to the distributed run
  - command/result counts
  - latency summaries
  - artifact validation status
- Add historical distributed-run list with filters by group, recipe, profile, user, status, date, and failure type.
- Add compare for two distributed runs:
  - changed recipe/profile
  - changed participant set
  - failure delta
  - timing delta
  - missing/extra received messages
- Reuse existing control-run artifact bundle where possible, and add distributed-run metadata as an optional artifact
  file.

Exit criteria:

- Ongoing and previous distributed runs can be reviewed from the SPA with enough evidence to reproduce failures.

Results:

- Added distributed-run monitor derivation helpers for command links, command/result snapshots, linked events, rollup
  failures, latency summaries, ACK readiness, per-agent progress, per-recipe progress, artifact validation, timeline
  rows, history filtering, and two-run comparison.
- Extended the `Distributed Recipes` tab with a monitor panel that shows failures first, agent/recipe progress, ACK
  readiness, optional barrier readiness, linked event stream, lifecycle timeline, command/result counts, latency
  metrics, and artifact status.
- Added historical distributed-run filters by group, recipe, profile, user, status, date, failure type, and text query.
- Added compare controls for two distributed runs covering changed recipe/profile, participant deltas, failure deltas,
  duration deltas, and received-message deltas when the linked control run snapshot is loaded.
- Reused the distributed artifact bundle files exposed by the control server and validates the expected JSON files in
  the SPA.

Verification:

- `npx vitest run packages/tests/rallar-black-box/app-tabs.test.ts packages/tests/rallar-black-box/rallar-mode-boundary.test.ts packages/tests/rallar-black-box/control-run-manager.test.ts packages/tests/rallar-black-box/distributed-recipes.test.ts`
  passed.
- `npm --workspace rallar-black-box run typecheck` passed.
- `npm run build:rallar-black-box` passed.

## Iteration 49: Schema-Driven Authoring And Validation UI

Status: completed on 2026-05-31.

Goal: Use JSON Schema to make recipes safer to edit and easier to explain.

Work:

- Validate Local Workbench, Manual Rallar exports, Flow Builder exports, Run Manager command JSON, and Distributed Run
  manifests in the browser.
- Show schema errors next to the relevant JSON editor.
- Add generated examples and snippets for each command kind.
- Add command capability help in the recipe catalog: what it sends, what it expects, which provider modes support it,
  and whether it can run distributed.
- Add compatibility warnings when a recipe requires live browser agents, Rallar Server auth, RTC signaling, or external
  runner execution.

Exit criteria:

- A human or AI can author/edit recipes in the UI with immediate validation and capability guidance.

Results:

- Added `src/schema-authoring.ts` with shared browser-side validation helpers for command JSON, browser-agent recipes,
  distributed-run manifests, and black-box-runner scenarios.
- Local Workbench now validates recipe JSON and manual command JSON next to the editors, disables invalid load/execute
  actions, and exposes generated command examples that can be inserted or copied.
- Manual Rallar now validates generated preview/export recipes, including matrix and negative recipe exports.
- Run Manager now validates command JSON before enqueue and shows generated command examples plus capability metadata.
- Flow Builder now validates SPA recipe exports and black-box-runner scenario exports.
- Distributed Recipes now validates manifest previews through the shared schema helper and shows capability details in
  recipe catalog rows.
- Capability help now includes command kind, provider modes, runtime surfaces, live-service requirements, artifact
  expectations, and distributed compatibility.

Verification:

- `npx vitest run packages/tests/rallar-black-box/schema-authoring.test.ts packages/tests/rallar-black-box/app-tabs.test.ts packages/tests/rallar-black-box/rallar-mode-boundary.test.ts packages/tests/rallar-black-box/control-run-manager.test.ts packages/tests/rallar-black-box/distributed-recipes.test.ts`
  passed.
- `npm --workspace rallar-black-box run typecheck` passed.
- `npm run build:rallar-black-box` passed.

## Iteration 50: Full-Stack Distributed Recipe QA

Status: completed on 2026-05-31.

Goal: Prove the distributed workflow with real browser agents and real data.

Work:

- Add Playwright tests with at least three browser contexts connected as control agents.
- Create/join a real Rallar group and resolve targets from that group.
- Execute a simple all-agent ACK recipe.
- Execute a sender/receiver WS recipe and verify received payloads in the receiving browsers.
- Execute a small RTC/realtime recipe and verify real delivery.
- Add negative tests:
  - one expected group member not connected as a control agent
  - one agent fails schema validation
  - one agent ACK timeout
  - one agent disconnects after staging
  - one recipe fails on one agent and rolls up correctly
- Verify distributed-run artifact export and historical-run display.

Exit criteria:

- Distributed recipe execution is covered by skip-safe full-stack tests and has reproducible redacted artifacts.

Results:

- Added `full-stack-distributed-recipes.spec.ts` with skip-safe full-stack distributed recipe coverage.
- The default full-stack path opens three simulated browser control agents, resolves them from reported
  application/workspace/group identity, runs an all-agent ACK distributed recipe, verifies artifact export, and checks
  the SPA historical-run display.
- Added negative Playwright coverage for invalid manifest schema, missing expected target count, ACK timeout, an agent
  disconnecting after staging, and a one-agent recipe failure rolling up to the distributed run.
- Added an opt-in live real-data matrix behind `RALLAR_BLACK_BOX_DISTRIBUTED_RECIPES=1`. It creates and joins a real
  Rallar group, runs group-target ACK, sends WS data from one browser and verifies the other browsers receive it, then
  connects RTC and verifies realtime delivery.
- Added a default third full-stack user (`charlie/secret`) to the distributed live gate, matching the API-v1 local
  authorised-client fixture so the root distributed command does not skip the live browser test for missing C auth.
- Changed the live distributed WS recipe to a server-accepted `room.*` user topic and resolved auth placeholders before
  browser-Rallar `ws.send`, so real fanout is not rejected as reserved `rallar.*` system traffic.
- Fixed the control-agent event matcher used by the live test so it matches browser `kind: "message"` transport events
  before unwrapping diagnostic payload details.
- Aligned the control protocol validator with the shared `rtc.connect`/`rtc.send` command types by allowing scoped
  `applicationId`, `workspaceId`, `scope`, `roomRef`, and `minSnapshotVersion` fields in distributed recipes.
- Added bootstrap support for application/workspace defaults and configurable control-agent heartbeat interval, so
  group-aware control identity is available immediately for target resolution.
- Added root command `npm run test:e2e:rallar-black-box:full-stack:real:distributed`.
- Added `docs/distributed-recipe-full-stack-qa.md` with simulated and live run instructions.

Verification:

- `npm --workspace rallar-black-box run typecheck` passed.
- `npx vitest run packages/tests/rallar-black-box/control-bootstrap.test.ts packages/tests/rallar-black-box/distributed-recipes.test.ts`
  passed.
- `deno test apps/rallar-black-box-control-server/test/control-service.test.ts` passed.
- `npm run test:e2e:rallar-black-box:full-stack:real:distributed` passed with the live three-browser distributed ACK,
  WS receive, RTC connect, and realtime send path enabled.
- `npx playwright test --config apps/rallar-black-box/playwright.full-stack.config.ts --list` discovered the new
  distributed recipe tests with skip-safe live gating.

## Iteration 51: Composite Recipe UX And Preflight

Status: completed on 2026-06-01.

Goal: Make looped, parallel, wait, and assert-based distributed recipes understandable before a user sends them to
browser agents.

Context:

- `rallar-bb-test` now supports composite browser-agent primitives such as `loop`, `parallel`, `wait`, and `assert`.
- The Distributed Recipes catalog already shows a compact command preview and recursively detects command kinds, but the
  UI does not yet explain the nested execution shape in enough detail.

Work:

- Add a recipe preflight summary in the Distributed Recipes catalog and manifest preview.
- Show:
  - top-level command count
  - effective operation count
  - loop count, duration, interval, and estimated frames/messages
  - parallel group count and max concurrency
  - wait/assert predicates and timeout risk
  - command kinds discovered inside nested recipes
  - live-service requirements discovered inside nested recipes
- Add badges or warnings for recipes that require real Rallar auth, real WebSocket signaling, RTC peers, or a live
  control server.
- Add a compact tree view for selected recipes so users can inspect parent and child commands without reading raw JSON.
- Keep raw JSON available for copy/debug workflows.

Exit criteria:

- A user can select a composite distributed recipe and understand what it will do, which live services it needs, and
  how much work it will schedule before staging the run.
- Recipes with nested live traffic produce visible compatibility warnings before execution.

Suggested verification:

- Add Vitest coverage for composite preflight derivation helpers.
- Add Playwright coverage that selects the `rtc-realtime` and `composite-evidence` recipes and verifies the UI shows
  loop, parallel, wait/assert, effective-operation, and live-service details.

Results:

- Added `distributedRecipePreflight()` in `src/distributed-recipes.ts` to derive top-level command count, effective
  operation count, effective frame count, max depth, loop estimates, parallel group/concurrency summaries, wait/assert
  predicates, command kinds, live-service requirements, compatibility warnings, service badges, and a compact execution
  tree from nested recipes.
- The `Distributed Recipes` catalog now shows preflight status and service badges per recipe, with selected rows opening
  a preflight panel that explains looped traffic, parallel groups, wait/assert guards, live requirements, and parent/child
  command shape without requiring raw JSON inspection.
- The manifest preview now includes selected-recipe preflight totals and expandable per-recipe preflight panels while
  keeping the raw manifest JSON available.

Verification:

- `npx vitest run packages/tests/rallar-black-box/distributed-recipes.test.ts` passed.
- `npm --workspace rallar-black-box run typecheck` passed.
- `npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/tabbed-navigation.spec.ts -g "shows distributed recipe composite preflight before staging"` passed.

## Iteration 52: Structured WS/RTC Runtime Diagnostics In The SPA

Status: completed on 2026-06-01.

Goal: Surface Rallar runtime warnings and transport diagnostics in the SPA instead of leaving them only in the browser
developer console.

Context:

- The live three-browser distributed recipe test passed, but the browser console showed useful warning signals:
  - `Unhandled WS message: ...`
  - `Received data channel for different data channel name: rtc-data-channel vs rtc-realtime`
- These signals are important during live distributed testing because they can explain missing messages, confusing
  routing, or unexpected RTC lane behavior.
- Shared-test Iteration 11 now provides
  `normalizeRallarBlackBoxRuntimeDiagnostic(...)` and bridges the known WS/RTC warning patterns into browser-agent
  diagnostic events. This SPA iteration should consume that contract instead of inventing a separate diagnostic shape.

Work:

- Add a structured diagnostics path from the browser Rallar facade/runtime into Rallar Trace, Event Stream, and RTC
  Diagnostics.
- Capture unhandled WebSocket message events with type ID, topic ID, route/context/resource IDs, sender ID, and a
  payload summary.
- Capture RTC data-channel mismatch events with peer ID, expected channel/lane label, observed channel label, current
  RTC connection state, and whether the event was ignored or accepted.
- Add severity levels such as `info`, `warn`, and `error`.
- Add filtering for diagnostics by transport, group, recipe/run ID, agent, and severity.
- Avoid treating every diagnostic as a failed test; make the distinction between observable warnings and terminal
  recipe failures explicit.

Exit criteria:

- Runtime WS/RTC warnings that currently appear in the browser console are also visible in the SPA.
- Distributed recipe failures can link to relevant runtime diagnostics when timestamps, agent IDs, or command IDs match.

Suggested verification:

- Add unit coverage for diagnostic normalization and redaction.
- Add Playwright coverage that injects or observes a warning diagnostic and verifies it appears in Rallar Trace or Event
  Stream with useful fields.
- Add a live-gated regression check once the live warning source is deterministic enough to assert without flakiness.

Results:

- The Distributed Recipes monitor now derives structured runtime diagnostics from linked control-run browser-agent
  events that carry normalized `rallar-bb-test` diagnostic payloads.
- WS diagnostics surface message/type/topic/context/resource IDs, sender, group, payload summary, severity, agent,
  command, and source metadata.
- RTC diagnostics surface peer/lane metadata, expected versus observed data-channel labels, accepted/ignored state,
  group, payload summary, severity, agent, command, and source metadata.
- The monitor now includes diagnostic counts, WS/RTC count split, a filterable `Runtime Diagnostics` section, and
  diagnostic timeline entries.
- Diagnostics are correlated to failures by command ID or near-time same-agent evidence, while remaining observable
  warnings unless the recipe result itself failed.

Verification:

- `npx vitest run packages/tests/rallar-black-box/distributed-recipes.test.ts` passed.
- `npm --workspace rallar-black-box run typecheck` passed.

## Iteration 53: Composite Run Monitor Drilldowns

Status: completed on 2026-06-01.

Goal: Make distributed run monitoring useful for composite recipes after they start running.

Context:

- Distributed runs already show agent progress, recipe progress, command links, timeline rows, artifact status, and
  failure rollups.
- Composite commands add another level of execution: a parent command can contain loop iterations, child commands,
  parallel groups, and nested wait/assert results.

Work:

- Extend the Distributed Recipes monitor to show expandable parent/child command results.
- For `loop` commands, show:
  - current or final iteration count
  - child result count
  - pass/fail counts
  - first failed iteration and command
  - elapsed duration and average cadence when available
- For `parallel` commands, show:
  - group count
  - max concurrency
  - per-group state
  - failed group and first failed child command
- For `wait` and `assert`, show matched event/result details, timeout status, and failed predicate information.
- Link nested child results back to command IDs, agent IDs, recipe IDs, and artifacts.
- Preserve the existing high-level monitor so simple recipes remain easy to read.

Exit criteria:

- A failed composite recipe can be debugged from the monitor without opening raw artifacts first.
- Loop and parallel progress are visible enough to distinguish transport failure, timing failure, and assertion failure.

Suggested verification:

- Add Vitest coverage for nested result summarization helpers.
- Add Playwright coverage using a simulated distributed recipe with loop, parallel, wait, assert, and one controlled
  failure to verify drilldown rendering and failure focus.

Implementation results:

- Added composite drilldown derivation to `apps/rallar-black-box/src/distributed-recipes.ts` for distributed
  `recipe.run` results whose child results contain `loop`, `parallel`, `wait`, or `assert` evidence.
- The monitor now exposes composite counts, display-safe nested rows, first failed child focus, per-parallel-group
  summaries, and artifact references back to `control-run.json`.
- Composite child failures are added to the monitor failure list so diagnostics can correlate with nested command IDs
  instead of only the parent distributed `recipe.run` command.
- The Distributed Recipes monitor UI now includes an expandable `Composite Drilldowns` section that preserves the
  existing high-level monitor panels while making loop cadence, parallel group state, wait matches, and failed asserts
  visible in context.

Verification:

- `npx vitest run packages/tests/rallar-black-box/distributed-recipes.test.ts` passed.
- `npm --workspace rallar-black-box run typecheck` passed.
- `npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/tabbed-navigation.spec.ts -g "shows distributed WS and RTC runtime diagnostics"` passed.

## Iteration 54: Schema Authoring Prompt Templates In The SPA

Status: planned.

Goal: Make it easier for humans or AI assistants to generate valid distributed recipes from the JSON Schema and existing
capability metadata.

Context:

- The schema and AI prompt guide now make it possible to generate black-box-runner and `rallar-bb-test` recipes.
- The SPA can become a practical authoring surface by exposing schema snippets, prompt templates, and preflight feedback
  close to the recipe editor/catalog.

Work:

- Add copyable prompt templates for common distributed recipe requests:
  - live group ACK
  - WS send and receive between browser agents
  - RTC realtime position stream
  - looped RTC load test
  - parallel WS/RTC smoke
  - wait/assert evidence recipe
- Add copyable schema snippets for browser-agent recipes and distributed-run manifests.
- Add a "Generate With AI" guidance panel that explains required inputs without embedding any AI provider dependency.
- Include current Global Context values as optional prompt variables, with secrets redacted.
- Add validation feedback that can be copied back into an AI prompt when generated JSON fails schema validation.

Exit criteria:

- A user can copy a prompt plus schema context from the SPA, ask an AI to generate a distributed recipe, paste the JSON
  back into the SPA, and get actionable validation/preflight feedback.

Suggested verification:

- Add unit coverage for prompt-template rendering and redaction.
- Add Playwright coverage for copying a prompt template and inserting a generated/example recipe into the authoring
  surface.

## Iteration 55: Live Distributed Warning Regression Coverage

Status: planned.

Goal: Keep the live distributed workflow from regressing as composite recipes and diagnostics become richer.

Context:

- Iteration 50 added skip-safe full-stack coverage for live ACK, WS receive, RTC connect, and realtime send.
- The next risk is that warnings remain invisible or are introduced by future transport changes while the tests still
  pass on the happy path.

Work:

- Extend live-gated Playwright coverage to verify diagnostic visibility for live distributed runs.
- Assert that WS receive and RTC receive evidence appears in both:
  - distributed run artifacts/results
  - visible SPA monitor/trace surfaces
- Add a test path for a composite live recipe such as `rtc-realtime` that verifies effective frame count, loop summary,
  and at least one received payload.
- Add a controlled negative live scenario when practical:
  - missing target agent
  - RTC no-peer/no-route
  - wait timeout
  - schema validation failure before staging
- Capture console warnings/errors as artifacts and fail only on configured high-severity diagnostics, not harmless known
  warnings.
- Document the live environment variables and local server startup commands needed to run this coverage.

Exit criteria:

- Live distributed recipe tests prove not only that data arrived, but also that the SPA shows the data, diagnostics, and
  composite execution details needed for a human to debug the run.

Suggested verification:

- `npm run test:e2e:rallar-black-box:full-stack:real:distributed` passes with the expanded live assertions when the
  required local or production Rallar services are configured.
- The same command remains skip-safe when the required environment variables or services are not present.
