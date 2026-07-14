# Rallar Recipe Console Control Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` or `superpowers:executing-plans`.
> Every behavioral slice follows red-green-refactor and records its focused
> command before the next slice begins.

**Goal:** Complete Iteration 3 by making a truthful, view-independent control
connection and repository-derived agent board the Recipe Console backbone,
without cutting over or hiding a legacy workflow.

**Architecture:** `App.tsx` passes a narrow bootstrap/control value into the
lazy Recipe Console. A root-owned sequential query service polls the canonical
bounded `GET /runs` adapter, preserves last-good evidence, brokers a token only
after an anonymous read is rejected, and stops when the experience unmounts.
Pure selection projection binds control run, distributed run, and agent context
to the existing v1 URL codec. React components only present the canonical
`deriveControlAgentBoardRows(...)` and `summarizeControlAgentBoardRows(...)`
outputs; they do not recreate targeting rules.

**Tech stack:** React 19, TypeScript, Vite 8, Vitest, Playwright, the existing
control-run manager and shared-test snapshot/target contracts.

## Binding Iteration 3 Decisions

- `apps/rallar-black-box/src/control-run-manager.ts` remains the canonical REST
  client. `recipe-console/control/control-api.ts` delegates to it and introduces
  no endpoint or snapshot type.
- Poll `GET /runs` immediately and then 5 seconds after each completed attempt.
  Requests time out after 4 seconds. HTTP query freshness is 15 seconds; the
  existing agent-heartbeat targetability threshold remains exactly 30 seconds.
- Query states are:
  - `connecting`: no completed attempt;
  - `live`: the latest bounded snapshot succeeded with distributed-run context;
  - `partial`: runs/agents are usable but optional distributed-run context is
    unavailable;
  - `stale`: a prior usable snapshot is retained after a failed or overdue
    refresh;
  - `offline`: no usable snapshot exists.
- Reachability and authorization are orthogonal to query state. A 401/403 is
  shown as `reachable · authorization required`, never as a network outage.
- The service records client `attemptedAtEpochMs` and `receivedAtEpochMs`.
  `run.updatedAtEpochMs` is mutation time and never connection freshness.
- The loop is serialized, deduplicates concurrent manual refreshes, aborts on
  stop/config change, ignores late results, and lives at Recipe Console root so
  view switches do not restart it.
- Use a manual bootstrap token when supplied. Otherwise try an anonymous local
  read; after 401/403, resolve the existing brokered operator token and retry
  once only when the endpoint provenance is trusted. Deployment-configured
  endpoints may use configured manual or brokered credentials. A URL-selected
  control endpoint receives only an anonymous request unless that same incoming
  URL explicitly supplied `controlToken`; ambient configured tokens and token
  brokering are withheld. A URL-selected API endpoint never receives the stored
  auth session and cannot auto-consume an agent-session ticket. After bootstrap,
  tokens remain memory-only and never appear in UI, logs, or local storage.
- Capture endpoint/credential provenance before synchronously scrubbing
  sensitive Recipe Console query/hash fields ahead of the login gate or lazy
  experience request. Legacy and `mode=control` runner-agent URLs retain their
  current ticket-consumption behavior.
- Deeply validate successful control payloads before repository derivation,
  including nested field types and unique control-run, distributed-run, and
  agent identities. Treat malformed core data as a reachable protocol failure;
  retain valid core runs as partial when only optional distributed context is
  malformed.
- A syntactically valid but unavailable URL ID remains visible and unresolved;
  it is never silently replaced by collection index zero or seeded data.
- Without an explicit URL run, prefer a known bootstrap run and replace URL
  history. Otherwise, if and only if the server exposes exactly one run, select
  it and replace URL history. Multiple unselected runs require an operator
  choice.
- A committed run selection pushes history and clears dependent agent and
  incompatible distributed-run selection. Agent selection pushes history.
- A selected distributed-run manifest group wins; otherwise a sole active run
  group wins; otherwise use bootstrap application/workspace/room context.
- On stale query data, last-known board rows remain visible but no row or count
  is described as currently safe. `summary.active` is an agent count, not a run
  count. Duplicate-session detection remains Iteration 4 work.
- Explicit Recipe Console canonical/share URLs remove `controlUrl`; legacy and
  runner-agent URLs keep their current behavior.
- Blank URLs remain legacy. No legacy primary navigation, existing legacy mount
  policy, rollback URL, endpoint, owner, hide, or cutover changes in I3. No
  existing export is removed, renamed, or made incompatible; additive
  `ControlRunManagerHttpError` and `RecipeConsoleControlProtocolError` exports
  preserve message compatibility without changing the control-server protocol.

## Task 1: Extract Bounded Recipe Console Composition

**Files:**

- Create `apps/rallar-black-box/src/recipe-console/app/RecipeConsoleWorkspace.tsx`
- Modify `apps/rallar-black-box/src/recipe-console/app/RecipeConsoleApp.tsx`
- Modify `packages/tests/rallar-black-box/recipe-console-structure.test.ts`

- [x] Add structure assertions for a thin provider/bootstrap app and a focused
  workspace owner; keep every Recipe Console TSX below 300 lines and
  `RecipeConsoleApp.tsx` below 180.
- [x] Run the focused structure test and observe the missing-owner failure.
- [x] Move existing workspace composition without behavioral change.
- [x] Run structure, seeded-state, URL/history tests and app typecheck.
- [x] Commit `refactor: split recipe console workspace composition` (`4be082e`).

Task 1 evidence: the untouched-production RED was 8/11 with exactly the three
new workspace-owner failures. GREEN passed 31/31 across structure, seeded
state, URL codec, and URL history; app typecheck passed. `RecipeConsoleApp.tsx`
is 23 lines and the focused workspace owner is 171 lines.

## Task 2: Canonical API Adapter, Cancellation, And Token Safety

**Files:**

- Create `apps/rallar-black-box/src/recipe-console/control/control-api.ts`
- Create `apps/rallar-black-box/src/recipe-console/control/control-credential-policy.ts`
- Create `apps/rallar-black-box/src/recipe-console/control/control-snapshot-validation.ts`
- Create `apps/rallar-black-box/src/app/recipe-console-url-guard.ts`
- Modify `apps/rallar-black-box/src/control-run-manager.ts`
- Modify `apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts`
- Modify `apps/rallar-black-box/src/recipe-console/routing/url-state-codec.ts`
- Test `packages/tests/rallar-black-box/recipe-console-control-api.test.ts`
- Test `packages/tests/rallar-black-box/control-run-manager.test.ts`
- Test `packages/tests/rallar-black-box/recipe-console-url-state.test.ts`

- [x] RED-test canonical delegation, exact snapshot bounds, Bearer headers,
  `AbortSignal`, structured HTTP status, malformed top-level snapshots,
  distributed-run fallback, anonymous success, 401 broker retry, cache reuse,
  manual-token precedence, and auth-session invalidation.
- [x] RED-test that explicit Recipe Console canonical/share URLs remove
  `controlUrl=...?...token=...` while legacy URLs remain untouched.
- [x] Add a backward-compatible structured HTTP error without changing existing
  message text. Inject cancellation through the existing `fetchFn` seam.
- [x] Implement the adapter by calling `controlHttpBaseUrlFromWsUrl(...)`,
  `fetchControlServerSnapshot(...)`, and compatibility-only
  `fetchDistributedRuns(...)`; validate the configured URL before delegation so
  invalid input never silently targets localhost.
- [x] Run the three focused tests and typecheck.
- [x] Commit `feat: add recipe console control API adapter` (`8bdf511`).

Task 2 evidence: RED failed only for the missing adapter, structured HTTP
status, and Recipe Console `controlUrl` scrubbing. Independent review then
found and mutation-probed fallback/broker cancellation, malformed fallback,
null snapshot, URL-userinfo, broker-status, credential-origin, pre-lazy secret,
ticket-origin, deep-shape, and duplicate-identity edge cases; each received its
own RED test and fix. The Task 2 checkpoint passed 40/40 and app typecheck; the
final review-remediation head is `a7df46f`.

## Task 3: Pure Query State And Serialized Polling Service

**Files:**

- Create `apps/rallar-black-box/src/recipe-console/control/control-query.ts`
- Test `packages/tests/rallar-black-box/recipe-console-control-query.test.ts`

- [x] RED-test connecting→live, complete→partial, live→stale with snapshot
  retention, initial failure→offline, 401 reachability, recovery, freshness at
  15,000/15,001ms, monotonic timestamps, and last error clearing.
- [x] RED-test immediate start, schedule-after-settle, no overlap, concurrent
  refresh deduplication, request timeout/abort, stop cleanup, restart, and late
  result suppression with injected clock/scheduler.
- [x] Implement the pure reducer and external-store-compatible query service.
- [x] Run the focused query test and mutation-probe overlap, stale retention,
  and cleanup guards.
- [x] Commit `feat: add recipe console control query service` (`7cbf1f3`).

Task 3 evidence: the initial RED was the missing query module. Independent
review then reproduced abort-aware timeout misclassification, reused timer
handle cross-generation cleanup, and a post-stop `isRefreshing` lie. Dedicated
RED cases now guard each edge. Final query validation passed 20/20 and app
typecheck; independent re-review approved the cohesive non-React query module.

## Task 4: URL-Coherent Control Selection

**Files:**

- Create `apps/rallar-black-box/src/recipe-console/control/control-selection.ts`
- Test `packages/tests/rallar-black-box/recipe-console-control-selection.test.ts`
- Extend `packages/tests/rallar-black-box/control-agent-board.test.ts`

- [x] RED-test explicit URL precedence, unresolved ID preservation, bootstrap
  preference, sole-run replacement suggestion, multiple-run ambiguity,
  deterministic ties, control/distributed membership, active-run cardinality,
  group precedence, run-change dependent-field clearing, and selected-agent
  restoration.
- [x] Extend board boundary proof for 30,000/30,001ms, offline, wrong group,
  missing identity/timestamps, CRDT capability, not-scoped, and synthetic rows.
- [x] Implement pure selection/projection only; no React fallback logic.
- [x] Run selection, board, URL, and history tests.
- [x] Commit `feat: derive recipe console control selection` (`18b34f7`).

Task 4 evidence: review-driven RED cases prevent false child-ID absence before
authoritative parent collections exist and cover authoritative missing IDs,
bootstrap/sole fallback, deterministic active ordering, exact heartbeat
freshness, missing timestamps, and not-scoped rows. Final selection/board proof
passed 28/28; the wider selection/board/URL/history slice passed 45/45 and app
typecheck. Independent re-review approved with no remaining finding.

## Task 5: Root Query Provider And Explicit Command Context

**Files:**

- Create `apps/rallar-black-box/src/recipe-console/control/ControlConnectionProvider.tsx`
- Create `apps/rallar-black-box/src/recipe-console/control/ControlCommandContext.tsx`
- Modify `apps/rallar-black-box/src/recipe-console/app/RecipeConsoleApp.tsx`
- Modify `apps/rallar-black-box/src/recipe-console/app/RecipeConsoleWorkspace.tsx`
- Modify `apps/rallar-black-box/src/recipe-console/shell/TopCommandBar.tsx`
- Modify `apps/rallar-black-box/src/recipe-console/shell/TopCommandBar.module.css`
- Modify `apps/rallar-black-box/src/App.tsx`
- Test `packages/tests/rallar-black-box/recipe-console-structure.test.ts`

- [x] RED-test the narrow App bootstrap value, root query owner, explicit status
  slot, and absence of legacy/control feature ownership in `App.tsx`.
- [x] Pass sanitized base URL, bootstrap run/group, API URL, manual token, and
  auth session. Keep refresh/remount semantics for preview state while the query
  provider and last-good evidence remain mounted.
- [x] Replace the seeded context string with labeled control server, run, group,
  connected, safe-target, active-run, and last-updated items.
- [x] Run structure, auth-flow, URL/history, typecheck, and build-boundary tests.
- [x] Commit `feat: connect recipe console command context` (`46dfbc0`).

Task 5 evidence: structural RED introduced five provider/bootstrap/status owner
failures while 11 prior checks stayed green. Review-driven RED cases then made
reachability visibly orthogonal to authorization/staleness and prevented a
selected terminal run from masking the actual active run. The focused control
and structure slice passed 73/73, command-context/structure passed 18/18,
typecheck/build and reciprocal chunk proof passed, and independent review
approved. Existing visual/browser strings intentionally move to Task 7.

## Task 6: Repository-Derived Agent Board

**Files:**

- Create `apps/rallar-black-box/src/recipe-console/control/ControlAgentBoard.tsx`
- Create `apps/rallar-black-box/src/recipe-console/control/ControlOverview.tsx`
- Create `apps/rallar-black-box/src/recipe-console/control/ControlOverview.module.css`
- Modify `apps/rallar-black-box/src/recipe-console/execute/ExecutePreview.tsx` or
  create a focused Execute route composition file
- Test `packages/tests/rallar-black-box/recipe-console-structure.test.ts`

- [x] Add render/browser RED assertions before UI implementation.
- [x] Render only rows from `deriveControlAgentBoardRows(...)` and summary from
  `summarizeControlAgentBoardRows(...)`; preserve every blocker reason as text.
- [x] Show live-empty, partial, stale-last-known, offline, authorization, and
  unresolved-selection panels without seed substitution.
- [x] Make run and agent controls keyboard operable with persistent selected
  state, 44px targets, visible focus, and URL push semantics.
- [x] Keep the deterministic Execute target preview visibly separate and
  preview-only until Iteration 4.
- [x] Run focused tests, app typecheck, and build.
- [x] Commit `feat: add recipe console control agent board`.

Task 6 evidence: render and structure tests failed first because no Control
overview owner existed, and the seven-scenario browser spec failed only at the
missing live/offline surfaces. The implementation renders canonical board rows
and summaries, retains stale evidence with zero current-safe targets, and keeps
the deterministic Execute preview in a separate module. React StrictMode
initially exposed a start/stop/start double-read that could discard the first
last-good snapshot; the provider now defers start through a cancellable
microtask and the stale-after-success browser proof guards it. Fresh validation
passed 45/45 focused structure/selection/board tests, 8/8 control browser tests,
app typecheck, and production build. Independent review then found inaccessible
agent safety names, clipped 932×430 Execute content, and a contradictory stale
blocked metric. Three dedicated browser checks failed first, pass after focused
ARIA/scroll/truth fixes, and the independent re-review approved the result.

## Task 7: Browser And Server Exit Proof

**Files:**

- Create `tests/playwright/rallar-black-box/recipe-console-control.spec.ts`
- Extend Recipe Console history/responsive/status/chunk specs only where the
  new truthful control backbone changes their contract.
- Add an actual-control smoke only if the existing standard harness can run it
  without changing production contracts.

- [x] Route-mock connected, stale-after-success, recovered, offline, partial,
  authorization-required, live-empty, wrong-group, and unavailable URL states.
- [x] Prove run/agent push, reload, copied link, back/forward, manual refresh,
  one poller across view changes, and zero polls after crossing to legacy.
- [x] Prove desktop, tablet, 430×932 portrait, 932×430 landscape, keyboard,
  touch targets, reduced motion, overflow, status announcements, and CSS
  isolation/load order.
- [x] Run the exact I3 focused Vitest slice, app typecheck/build, chunk proof,
  `deno task check`, and `deno task test` in the control server.
- [x] Run the complete Recipe Console Playwright config, exact legacy
  navigation/ticket pair, complete app Vitest suite, and shared-test check.
- [x] Attempt the available actual local-control smoke. Record any unavailable
  live/Postgres lifecycle as skipped with the exact required reason.

Task 7 evidence: the complete mocked/control and established browser suites
pass 64/64 Recipe Console Chromium cases and 28/28 preserved legacy
navigation/ticket cases. Coverage includes live, heartbeat-stale agent,
offline agent, wrong group, missing identity, partial, stale last-good,
recovery, offline, authorization-required, credential-trust-required,
live-empty, unavailable IDs, malformed core/optional payloads, duplicate
identities, stored-credential withholding from URL-selected origins, pre-lazy
secret scrubbing, and ticket blocking for a URL-selected API origin. Desktop,
tablet, 430×932 portrait, 932×430 landscape, keyboard-only run/agent selection,
44px control targets, reduced motion, status announcements, overflow, poll
cleanup after an elapsed interval, and real navigation CSS isolation pass. The
independently reviewed 4% Execute visual delta was limited to the intentional
control context/overview and is now the frozen-clock baseline. The in-app
Browser remained unavailable exactly as `Browser is not available: iab`;
discovery returned `[]`, so controlled Playwright/System Chrome is the recorded
fallback rather than an in-app Browser pass.

The exact ten-file focused unit slice passed 155/155, the complete app suite
passed 567/567 across 62 files outside the socket-restricted sandbox, app
typecheck passed, the 458-module production build and reciprocal experience
chunk proof passed, and the control server passed check plus 57/57 tests. The
shared-test TypeScript check and all seven Deno check entries passed; the
combined npm script required the equivalent `--node-modules-dir=none` Deno
override because this isolated worktree has a deliberately sparse local
`node_modules` under the repository's root `nodeModulesDir: manual`, so the
unmodified script could not resolve `@types/node` despite the parent checkout's
installed dependency. The reproducible non-mutating standard-harness command
`RALLAR_BLACK_BOX_LOCAL_CONTROL_SMOKE=1 npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/control-foundation-local-smoke.spec.ts`
passed 1/1 against the actual local control process and its real bounded
`GET /runs`. Independent final code/contract and browser/validation review found
no Critical or Important issue. The local GET smoke and Deno suite prove
read/contract behavior only, not a distributed lifecycle. The configured
`recipe-console-execute.spec.ts` lifecycle acceptance remains absent; visible
create, stage, start, monitor, cancel, and export remain Iterations 4–5.
The Postgres-backed distributed lifecycle remains **skipped, not passed**, for
exactly: `Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
apps/rallar-black-box-control-server, and apps/rallar-black-box available.`

## Task 8: Review, Evidence, And Iteration Milestone

- [x] Dispatch independent contract/code review and browser/validation review.
- [x] Mutation-probe last-good retention, collection-index fallback, seed
  fallback, URL-field loss, token/controlUrl leakage, duplicate polling, missing
  abort, stale-as-safe presentation, credential-origin leakage, broker error
  provenance, pre-lazy secret exposure, ticket-origin behavior, nested protocol
  validation, and duplicate identities.
- [x] Update the parent execution ledger and migration register with actual
  commits, decisions, exit evidence, remaining Ready-State #3 risk, and no
  workflow cutover/hide.
- [x] Rerun fresh exit validation after every review fix.
- [x] Commit `docs: record recipe console control exit` only when the I3 exit
  criterion is satisfied.

Task 8 evidence: independent final review approved the implementation with no
Critical or Important issue, every review remediation received focused
RED/GREEN proof, and fresh exit validation passed at code head `a7df46f`. This
documentation milestone records the satisfied Iteration 3 exit. No legacy owner,
existing legacy mount policy, navigation visibility, hide, rollback, or workflow
cutover changed. Ready-State #3 remains open for Iterations 4–5 and the
configured Postgres lifecycle proof.

## Exact Focused Validation

```bash
npx vitest run \
  packages/tests/rallar-black-box/control-client.test.ts \
  packages/tests/rallar-black-box/control-run-manager.test.ts \
  packages/tests/rallar-black-box/control-agent-board.test.ts \
  packages/tests/rallar-black-box/recipe-console-control-api.test.ts \
  packages/tests/rallar-black-box/recipe-console-control-command-context.test.ts \
  packages/tests/rallar-black-box/recipe-console-control-query.test.ts \
  packages/tests/rallar-black-box/recipe-console-control-selection.test.ts \
  packages/tests/rallar-black-box/recipe-console-url-state.test.ts \
  packages/tests/rallar-black-box/recipe-console-url-history.test.ts \
  packages/tests/rallar-black-box/recipe-console-structure.test.ts

npm --workspace rallar-black-box run typecheck
npm --workspace rallar-black-box run build
npx tsx apps/rallar-black-box/scripts/assert-experience-chunks.ts

cd apps/rallar-black-box-control-server
deno task check
deno task test
```

The configured Postgres lifecycle is not implied by mocked UI or Deno contract
proof. If unavailable, record it as skipped, never passed, with exactly:

`Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
apps/rallar-black-box-control-server, and apps/rallar-black-box available.`
