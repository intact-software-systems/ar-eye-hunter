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
  once. Tokens remain memory-only and never appear in URLs, UI, logs, or local
  storage.
- A syntactically valid but unavailable URL ID remains visible and unresolved;
  it is never silently replaced by collection index zero or seeded data.
- Without an explicit URL run, prefer a known bootstrap run. If and only if the
  server exposes exactly one run, select it and replace URL history. Multiple
  unselected runs require an operator choice.
- A committed run selection pushes history and clears dependent agent and
  incompatible distributed-run selection. Agent selection pushes history.
- A selected distributed-run manifest group wins; otherwise a sole active run
  group wins; otherwise use bootstrap application/workspace/room context.
- On stale query data, last-known board rows remain visible but no row or count
  is described as currently safe. `summary.active` is an agent count, not a run
  count. Duplicate-session detection remains Iteration 4 work.
- Explicit Recipe Console canonical/share URLs remove `controlUrl`; legacy and
  runner-agent URLs keep their current behavior.
- Blank URLs remain legacy. No legacy primary navigation, mount policy,
  rollback URL, endpoint, public export, or control protocol changes in I3.

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
- [ ] Commit `refactor: split recipe console workspace composition`.

Task 1 evidence: the untouched-production RED was 8/11 with exactly the three
new workspace-owner failures. GREEN passed 31/31 across structure, seeded
state, URL codec, and URL history; app typecheck passed. `RecipeConsoleApp.tsx`
is 23 lines and the focused workspace owner is 171 lines.

## Task 2: Canonical API Adapter, Cancellation, And Token Safety

**Files:**

- Create `apps/rallar-black-box/src/recipe-console/control/control-api.ts`
- Modify `apps/rallar-black-box/src/control-run-manager.ts`
- Modify `apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts`
- Modify `apps/rallar-black-box/src/recipe-console/routing/url-state-codec.ts`
- Test `packages/tests/rallar-black-box/recipe-console-control-api.test.ts`
- Test `packages/tests/rallar-black-box/control-run-manager.test.ts`
- Test `packages/tests/rallar-black-box/recipe-console-url-state.test.ts`

- [ ] RED-test canonical delegation, exact snapshot bounds, Bearer headers,
  `AbortSignal`, structured HTTP status, malformed top-level snapshots,
  distributed-run fallback, anonymous success, 401 broker retry, cache reuse,
  manual-token precedence, and auth-session invalidation.
- [ ] RED-test that explicit Recipe Console canonical/share URLs remove
  `controlUrl=...?...token=...` while legacy URLs remain untouched.
- [ ] Add a backward-compatible structured HTTP error without changing existing
  message text. Inject cancellation through the existing `fetchFn` seam.
- [ ] Implement the adapter by calling `controlHttpBaseUrlFromWsUrl(...)`,
  `fetchControlServerSnapshot(...)`, and compatibility-only
  `fetchDistributedRuns(...)`; validate the configured URL before delegation so
  invalid input never silently targets localhost.
- [ ] Run the three focused tests and typecheck.
- [ ] Commit `feat: add recipe console control API adapter`.

## Task 3: Pure Query State And Serialized Polling Service

**Files:**

- Create `apps/rallar-black-box/src/recipe-console/control/control-query.ts`
- Test `packages/tests/rallar-black-box/recipe-console-control-query.test.ts`

- [ ] RED-test connecting→live, complete→partial, live→stale with snapshot
  retention, initial failure→offline, 401 reachability, recovery, freshness at
  15,000/15,001ms, monotonic timestamps, and last error clearing.
- [ ] RED-test immediate start, schedule-after-settle, no overlap, concurrent
  refresh deduplication, request timeout/abort, stop cleanup, restart, and late
  result suppression with injected clock/scheduler.
- [ ] Implement the pure reducer and external-store-compatible query service.
- [ ] Run the focused query test and mutation-probe overlap, stale retention,
  and cleanup guards.
- [ ] Commit `feat: add recipe console control query service`.

## Task 4: URL-Coherent Control Selection

**Files:**

- Create `apps/rallar-black-box/src/recipe-console/control/control-selection.ts`
- Test `packages/tests/rallar-black-box/recipe-console-control-selection.test.ts`
- Extend `packages/tests/rallar-black-box/control-agent-board.test.ts`

- [ ] RED-test explicit URL precedence, unresolved ID preservation, bootstrap
  preference, sole-run replacement suggestion, multiple-run ambiguity,
  deterministic ties, control/distributed membership, active-run cardinality,
  group precedence, run-change dependent-field clearing, and selected-agent
  restoration.
- [ ] Extend board boundary proof for 30,000/30,001ms, offline, wrong group,
  missing identity/timestamps, CRDT capability, not-scoped, and synthetic rows.
- [ ] Implement pure selection/projection only; no React fallback logic.
- [ ] Run selection, board, URL, and history tests.
- [ ] Commit `feat: derive recipe console control selection`.

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

- [ ] RED-test the narrow App bootstrap value, root query owner, explicit status
  slot, and absence of legacy/control feature ownership in `App.tsx`.
- [ ] Pass sanitized base URL, bootstrap run/group, API URL, manual token, and
  auth session. Keep refresh/remount semantics for preview state while the query
  provider and last-good evidence remain mounted.
- [ ] Replace the seeded context string with labeled control server, run, group,
  connected, safe-target, active-run, and last-updated items.
- [ ] Run structure, auth-flow, URL/history, typecheck, and build-boundary tests.
- [ ] Commit `feat: connect recipe console command context`.

## Task 6: Repository-Derived Agent Board

**Files:**

- Create `apps/rallar-black-box/src/recipe-console/control/ControlAgentBoard.tsx`
- Create `apps/rallar-black-box/src/recipe-console/control/ControlOverview.tsx`
- Create `apps/rallar-black-box/src/recipe-console/control/ControlOverview.module.css`
- Modify `apps/rallar-black-box/src/recipe-console/execute/ExecutePreview.tsx` or
  create a focused Execute route composition file
- Test `packages/tests/rallar-black-box/recipe-console-structure.test.ts`

- [ ] Add render/browser RED assertions before UI implementation.
- [ ] Render only rows from `deriveControlAgentBoardRows(...)` and summary from
  `summarizeControlAgentBoardRows(...)`; preserve every blocker reason as text.
- [ ] Show live-empty, partial, stale-last-known, offline, authorization, and
  unresolved-selection panels without seed substitution.
- [ ] Make run and agent controls keyboard operable with persistent selected
  state, 44px targets, visible focus, and URL push semantics.
- [ ] Keep the deterministic Execute target preview visibly separate and
  preview-only until Iteration 4.
- [ ] Run focused tests, app typecheck, and build.
- [ ] Commit `feat: add recipe console control agent board`.

## Task 7: Browser And Server Exit Proof

**Files:**

- Create `tests/playwright/rallar-black-box/recipe-console-control.spec.ts`
- Extend Recipe Console history/responsive/status/chunk specs only where the
  new truthful control backbone changes their contract.
- Add an actual-control smoke only if the existing standard harness can run it
  without changing production contracts.

- [ ] Route-mock connected, stale-after-success, recovered, offline, partial,
  authorization-required, live-empty, wrong-group, and unavailable URL states.
- [ ] Prove run/agent push, reload, copied link, back/forward, manual refresh,
  one poller across view changes, and zero polls after crossing to legacy.
- [ ] Prove desktop, tablet, 430×932 portrait, 932×430 landscape, keyboard,
  touch targets, reduced motion, overflow, status announcements, and CSS
  isolation/load order.
- [ ] Run the exact I3 focused Vitest slice, app typecheck/build, chunk proof,
  `deno task check`, and `deno task test` in the control server.
- [ ] Run the complete Recipe Console Playwright config, exact legacy
  navigation/ticket pair, complete app Vitest suite, and shared-test check.
- [ ] Attempt the available actual local-control smoke. Record any unavailable
  live/Postgres lifecycle as skipped with the exact required reason.

## Task 8: Review, Evidence, And Iteration Milestone

- [ ] Dispatch independent contract/code review and browser/validation review.
- [ ] Mutation-probe last-good retention, collection-index fallback, seed
  fallback, URL-field loss, token/controlUrl leakage, duplicate polling, missing
  abort, and stale-as-safe presentation.
- [ ] Update the parent execution ledger and migration register with actual
  commits, decisions, exit evidence, remaining Ready-State #3 risk, and no
  workflow cutover/hide.
- [ ] Rerun fresh exit validation after every review fix.
- [ ] Commit `docs: record recipe console control exit` only when the I3 exit
  criterion is satisfied.

## Exact Focused Validation

```bash
npx vitest run \
  packages/tests/rallar-black-box/control-client.test.ts \
  packages/tests/rallar-black-box/control-run-manager.test.ts \
  packages/tests/rallar-black-box/control-agent-board.test.ts \
  packages/tests/rallar-black-box/recipe-console-control-api.test.ts \
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
