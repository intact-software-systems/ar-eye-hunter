# Rallar Recipe Console Monitor Workflow Implementation Plan

Status: Iteration 5 complete; Tasks 0–6 complete, no legacy workflow cutover
Evidence date: 2026-07-12
Branch: `codex/rallar-black-box-spa-reimplementation`
Worktree: `tmp/worktrees/rallar-black-box-spa`

## Objective

Replace the synthetic Recipe Console Monitor with a bounded live workflow that
lets an operator understand a running or failed distributed run in under five
seconds. The first visible region must answer what happened, who is affected,
and what to inspect next. Failure evidence precedes timeline/event noise, every
available correlation is operable, and last-known evidence survives refresh
failures without being represented as current-safe.

Iteration 5 does not hide a legacy row. `runner.runs` still owns history,
offline import/analysis, comparison, and local-run surfaces assigned to later
iterations. `legacy.distributed-recipes` still owns history, comparison,
diagnostics, and authoring. Their mounts, primary visibility, aliases, deep
links, and rollback URLs remain unchanged.

## Authoritative Findings

- `RecipeConsoleWorkspace` currently preserves the Execute run IDs in the v1
  URL but renders unrelated `seed-*` Monitor evidence. No synthetic fallback
  may remain as apparent live truth after this iteration.
- The root `ControlConnectionProvider` is the single poll owner. A total query
  failure already preserves its snapshot as stale, but a successful partial
  response can omit `distributedRuns` and replace the prior coherent snapshot.
  Monitor therefore needs a context-keyed last-known projection.
- `FailureInspector` derives all copy from the first failure even after another
  row is selected. Correlation must be deterministic per selected failure in
  `packages/shared-test/**`.
- Role-scoped recipes currently count every run target as expected, although
  the control server dispatches them only to matching role/recipe assignments.
  Shared recipe progress must match the authoritative dispatch rules.
- Existing control contracts are sufficient. Reads continue through the root
  bounded query; Cancel and artifact load/export continue through the
  credential-aware execution adapter. Monitor must not import
  `control-run-manager.ts`, call `fetch` directly, or create a second poller.
- The full-stack config matches only `full-stack-*.spec.ts`; the env-gated test
  in `recipe-console-execute.spec.ts` is not run by the canonical distributed
  full-stack command. A matching full-stack acceptance wrapper is required.

## Binding Design And Safety Decisions

1. Direction A, Signal Ledger, remains the visual contract: verdict, failures,
   agent/phase evidence, then bounded secondary evidence with one contextual
   inspector. This is not a new visual-direction checkpoint.
2. Only a sole compatible distributed run may auto-canonicalize into the URL,
   using replace. Multiple runs remain explicit; an unavailable requested ID
   remains visible and never falls back by collection index.
3. A coherent Monitor source is keyed by normalized control base URL,
   `controlRunId`, and `distributedRunId`. A context change clears cached run,
   artifact, selection, arming, errors, and in-flight operation authority.
4. Current compatible complete/partial evidence replaces cached evidence.
   Total stale failures retain it as last-known. A partial core snapshot that
   omits distributed context may retain the prior same-context run/control pair
   but must not combine an old distributed run with a new unrelated control
   run. A complete authoritative omission clears the run.
5. Snapshot bounds are passed to shared analysis and truncation warnings are
   rendered. Timeline, events, and diagnostics remain secondary and bounded
   with an explicit omitted-count label; Iteration 9 owns virtualization.
6. Artifact bundles stay in memory and load only on explicit operator action.
   Load/export preserves an existing same-run artifact on failure, exposes the
   new error, validates returned run identity, and ignores abort-resistant late
   responses after context changes.
7. Cancel requires complete live truth, a current non-terminal selected run,
   exact context arming, and an accessible confirmation dialog. Partial, stale,
   offline, authorization-required, credential-trust, and terminal states block
   it. A successful mutation is projected immediately and followed by the root
   query's `refreshAfterCurrent()` ordering.
8. Failure selection may project existing URL-backed agent/recipe/command IDs;
   failure, diagnostic, timeline, and artifact selection remains bounded local
   state because v1 defines no shareable ID fields for them. New-run selection
   clears incompatible URL fields. Diagnostic severity and transport filters
   use their existing v1 fields.
9. The inspector supports failure, agent, recipe, command, diagnostic,
   timeline, and artifact evidence. A context-preserving legacy link carries
   only non-secret provider/run/evidence IDs to the registered rollback route.
10. `RecipeConsoleWorkspace`, `MonitorWorkspace`, each TSX leaf, each hook/pure
    owner, and every CSS Module remain bounded. No registry, global stylesheet,
    hidden-mounted replacement, legacy React import, or new shared monolith is
    allowed.

## Task 0: Baseline And Critical Review

- [x] Read the parent plan, product spec, migration register, Direction A
      fidelity contract, shared monitor derivations, live control query/selection,
      execution adapter, legacy monitor behavior, browser tests, and full-stack
      configuration.
- [x] Dispatch independent contract, UI/browser, and control/live audits.
- [x] Establish a green baseline: 83/83 across
      `distributed-recipes`, seeded state, URL state, and structure tests; app
      typecheck passes.
- [x] Record the critical partial-refresh, selected-failure, role-scope, and
      full-stack-discovery gaps in this plan before editing code.

## Task 1: Correct Shared Monitor Truth

Files:

- Modify `packages/shared-test/rallar-bb-test/distributed-run-monitor.ts`
- Create `packages/shared-test/rallar-bb-test/distributed-run-evidence.ts`
- Modify `packages/shared-test/rallar-bb-test/mod.ts`
- Modify `apps/rallar-black-box/src/distributed-recipes.ts`
- Modify `packages/tests/rallar-black-box/distributed-recipes.test.ts`

- [x] RED-test role-scoped expected agents using resolved assignments,
      manifest assignments, `recipeIds`, and role-only selections; prove no sibling
      role is falsely counted missing.
- [x] RED-test selected-failure evidence destinations for first and later run,
      participant, recipe, command, and composite failures. Agent, recipe, command,
      direct diagnostics, matching timeline/events, and valid artifact destinations
      appear only when available.
- [x] Implement narrow deterministic helpers without changing existing
      signatures or exports. Additive public exports remain available from both
      shared-test and the app compatibility barrel.
- [x] Pass focused shared tests and shared-test TypeScript checks.
- [x] Commit `fix: derive role-aware distributed monitor evidence`.

**Actual evidence (2026-07-12):** commit `46ea153`; the original role RED
reported all three recipes against all three targets, and selected-failure/
composite RED cases returned no destinations. Shared truth now mirrors the
control service's resolved-to-manifest assignment precedence and derives
collision-safe agent/recipe/command/diagnostic/timeline/event/artifact
destinations for the selected failure. Independent review found two Important
correlation gaps; duplicate-key and rollup-dimension RED cases cover both
fixes. Final focused validation passes 45/45 plus shared-test typecheck, and the
new reusable owner is bounded at 291 lines.

## Task 2: Reconcile Coherent Monitor State And Policies

Files:

- Create `apps/rallar-black-box/src/recipe-console/monitor/monitor-workspace-state.ts`
- Create `apps/rallar-black-box/src/recipe-console/monitor/monitor-operation-state.ts`
- Create `apps/rallar-black-box/src/recipe-console/monitor/monitor-workspace-model.ts`
- Create `apps/rallar-black-box/src/recipe-console/monitor/monitor-selection.ts`
- Create `apps/rallar-black-box/src/recipe-console/monitor/monitor-action-policy.ts`
- Create `packages/tests/rallar-black-box/recipe-console-monitor-state.test.ts`
- Create `packages/tests/rallar-black-box/recipe-console-monitor-action-policy.test.ts`
- Modify `packages/tests/rallar-black-box/recipe-console-control-selection.test.ts`

- [x] RED-test no selection, sole-run canonicalization, explicit unavailable and
      incompatible IDs, multiple-run ambiguity, and run-selection dependency
      clearing.
- [x] RED-test complete current evidence, total stale/offline preservation,
      partial distributed-context preservation, partial coherent replacement,
      authoritative deletion, recovery, newer mutation truth, and context-change
      clearing. Never mix unrelated run/control snapshots.
- [x] RED-test artifact pending/success/failure retention, identity mismatch,
      operation generations, and abort-resistant stale response rejection.
- [x] RED-test Cancel/Load/Export policies across live, partial, stale, offline,
      authorization, credential-trust, non-terminal, terminal, busy, armed, and
      unarmed states.
- [x] Derive monitor/report/verdict once per coherent source, with
      `RECIPE_CONSOLE_CONTROL_SNAPSHOT_BOUNDS` supplied to analysis.
- [x] Pass focused state/policy/selection tests and app typecheck.
- [x] Commit `feat: reconcile live monitor workspace truth`.

**Actual evidence (2026-07-12):** commit `acd9839`; initial imports failed RED
before the five bounded pure owners existed. A review-driven partial-present
omission RED prevented indefinite last-known retention, and independent review
added non-authoritative sole-run plus equal-timestamp terminal/error-rich tie
RED cases. Complete, partial, stale, offline, deletion, recovery, mutation,
artifact identity/retention, operation generation, and fail-closed action
policy now pass 51/51 focused assertions plus app typecheck. Every pure owner
is at or below 234 lines.

## Task 3: Bind Root Control Operations

Files:

- Create `apps/rallar-black-box/src/recipe-console/monitor/use-monitor-workspace.ts`
- Create `apps/rallar-black-box/src/recipe-console/monitor/use-monitor-operations.ts`
- Create `apps/rallar-black-box/src/recipe-console/control/ControlRunCancelDialog.tsx`
- Create `apps/rallar-black-box/src/recipe-console/control/ControlRunCancelDialog.module.css`
- Modify `apps/rallar-black-box/src/recipe-console/execute/ExecuteCancelDialog.tsx`
- Modify `apps/rallar-black-box/src/recipe-console/execute/ExecuteCancelDialog.module.css`
- Modify `packages/tests/rallar-black-box/recipe-console-structure.test.ts`

- [x] RED-test structural ownership: no Monitor fetch/timer/legacy imports,
      bounded owners, no seeded Monitor dependencies, root execution adapter only,
      and shared confirmation ownership without Execute-to-Monitor coupling.
- [x] Bind Refresh, Cancel, Load artifact, and Export to the current context.
      Abort on route/context changes, check context again after every await, retain
      same-run artifact on load failure, download deterministic content/filename,
      project successful Cancel, and queue `refreshAfterCurrent()`.
- [x] Extract the accessible focus-trapped Cancel confirmation behind a narrow
      control-level component while preserving Execute behavior and selectors.
- [x] Pass focused operation/structure/Execute regression tests and typecheck.
- [x] Commit `feat: bind live monitor control operations`.

**Actual evidence (2026-07-12):** commit `b2a2002`; missing bounded owners were
the structural RED. Monitor now binds only the root credential-aware execution
adapter, context-bound operation generations, post-await identity checks,
abort-resistant stale-response rejection, deterministic artifact downloads,
structured operation provenance, Cancel response classification, and queued
post-mutation refresh. Execute keeps its public paths through thin compatibility
wrappers over the shared control dialog/error/download owners. Independent
review found no Critical or Important issue. The focused slice passes 57/57,
app typecheck passes, and the three existing Execute Cancel/focus/reduced-motion
Chromium regressions pass.

## Task 4: Replace Synthetic Monitor With Bounded Live UI

Files:

- Create `apps/rallar-black-box/src/recipe-console/monitor/MonitorWorkspace.tsx`
- Create focused leaves under `apps/rallar-black-box/src/recipe-console/monitor/**`
  for run selection, verdict, failure ledger, progress/readiness, diagnostics,
  secondary evidence, action band, and inspector
- Create one scoped CSS Module per bounded visual owner
- Create `apps/rallar-black-box/src/recipe-console/monitor/legacy-monitor-link.ts`
- Modify `apps/rallar-black-box/src/recipe-console/app/RecipeConsoleWorkspace.tsx`
- Modify `apps/rallar-black-box/src/recipe-console/data/seeded-console-state.ts`
- Modify `apps/rallar-black-box/src/recipe-console/data/recipe-console-models.ts`
- Remove `MonitorPreview.tsx`, `FailureInspector.tsx`, and their monolithic CSS
- Modify focused structure, seeded-state, URL-state, and navigation tests

- [x] Add structure and model RED assertions before React implementation.
- [x] Render current/last-known provenance, run selection, verdict, affected
      identity, next action, failures, agent × phase matrix, recipe progress, ACK
      and barrier readiness, diagnostic counts/filtering, artifact status, and
      bounded timeline/event/composite evidence in failure-first order.
- [x] Make every available correlated evidence destination operable. Update
      agent/recipe/command URL state and restore it through reload/back/copy.
- [x] Preserve the 360px desktop inspector, tablet overlay, portrait dock/sheet,
      landscape split, keyboard selection, focus trap/restore, 44px targets,
      reduced motion, announcements, and contained scrolling.
- [x] Render honest empty, loading, current, partial, stale, offline,
      authorization, credential-trust, running, waiting ACK/barrier, ready, passed,
      failed, timed-out, cancelled, artifact missing/invalid, and recovered states.
- [x] Remove only seeded Monitor ownership; keep Tune's deterministic seed
      isolated. Keep both legacy workflow rows visible and uncut.
- [x] Pass focused unit/structure/browser RED→GREEN, typecheck, and build.
- [x] Commit `feat: replace seeded monitor with live evidence`.

**Actual evidence (2026-07-12):** commit `c7a36e0`; the initial model/structure
RED exposed the seeded Monitor owner and ten missing live composition owners.
The live workspace now renders verdict → visible actions → failures → agent and
role-scoped recipe/readiness evidence → bounded secondary evidence, with one
contextual inspector and a safe legacy Runs link. Synthetic Monitor state and
the three monolithic preview owners are removed; Tune remains the sole seeded
model. Independent root-state and UI reviews found URL projection, run-switch,
empty-inspector, role-collision, artifact-selection, keyboard-semantics, and
ambiguous-role status issues; each received focused RED/GREEN coverage. The
complete app suite passes 699/699, app typecheck and the 506-module production
build pass, and focused Chromium proves the root poll remains singular and is
cancelled on Recipe Console unmount. Task 5 still owns the full responsive and
operational Monitor acceptance matrix; no legacy workflow row is cut over.

## Task 5: Browser, Full-Stack, And Cutover Proof

Files:

- Create `tests/playwright/rallar-black-box/recipe-console-monitor.spec.ts`
- Create bounded Monitor fixture helpers under
  `tests/playwright/rallar-black-box/**`
- Modify existing Recipe Console shell/history/status/responsive/CSS/fidelity
  specs to use deterministic live Monitor snapshots instead of seed fallback
- Modify `tests/playwright/rallar-black-box/recipe-console-execute.spec.ts`
- Create `tests/playwright/rallar-black-box/full-stack-recipe-console-monitor.spec.ts`
- Modify the canonical distributed full-stack npm script to include that file
- Update controlled Darwin Monitor baselines without changing Direction A

- [x] Keep these acceptance names exact:
      `places the failure verdict and failure list before raw event evidence`;
      `opens all available correlated evidence from a failure row`;
      `preserves last-known evidence while a selected run refresh fails`; and
      `completes the configured live distributed run lifecycle and exports its artifact`.
- [x] Prove a mocked one-agent failure, running/pass/fail/timeout/cancelled and
      reconnect transitions, complete/partial/stale/offline truth, Execute handoff,
      copied deep-link restoration, bounded secondary evidence, armed visible
      Cancel, artifact Load/Export, and abort-ignoring late responses.
- [x] Prove desktop, tablet, 430×932 portrait, 932×430 landscape,
      keyboard-only paths, 44px targets, focus trap/restore, reduced motion,
      announcements, no document overflow, and actual Monitor CSS in both load
      orders. Refresh and inspect the approved Monitor baselines.
- [x] Extend the configured Postgres acceptance through visible Monitor truth
      and a distinct live non-terminal cancellation. The full-stack wrapper must
      verify per-target cancel links and dispatched/completed `recipe.cancel`
      commands. If unavailable, skip for exactly:
      `Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
  apps/rallar-black-box-control-server, and apps/rallar-black-box available.`
- [x] Commit `test: prove live monitor lifecycle and evidence`.

**Actual evidence (2026-07-12):** commit `42eedae` replaces every remaining
seed-dependent Monitor browser assertion with deterministic live control
snapshots and keeps all four acceptance names exact. Seven focused Monitor
cases cover failure-first order, every rendered correlation, copied URL
restoration, complete/partial/stale/offline/recovered truth, authoritative
disconnect → reconnect evidence, running/passed/failed/timed-out/cancelled,
armed confirmation and Cancel POST, schema-v2 Load/Export, 47 → 40 bounded
events with the exact omitted count, authoritative deletion, and an
abort-ignoring late artifact response. The existing simulated Execute
lifecycle now hands the selected passed run to Monitor, and a two-run
contextual link proves legacy Runs restores the requested older run rather than
the newest run.

The configured acceptance moved to the discovered
`full-stack-recipe-console-monitor.spec.ts` owner. It drives a visible passed
Execute → Monitor export and a distinct ready → Monitor → cancelled run, then
checks one cancel link per target plus dispatched/completed successful
`recipe.cancel` commands. The canonical command now forces a fresh
`RALLAR_SQL_BACKEND=postgres` API process and rejects reachable malformed,
non-OK, wrong-service, or wrong-protocol evidence instead of converting it to
a skip. The current environment did not provide the configured Postgres stack;
the wrapper therefore produced exactly one skip with the required reason and
is not represented as a live pass.

## Task 6: Fresh Exit, Review, And Documentation

- [x] Run the exact focused unit list, complete app suite, shared-test check,
      app typecheck/build/chunk assertion, complete Recipe Console browser config,
      exact legacy navigation/ticket pair, control-server check/test, and the
      configured full-stack acceptance when services are available.
- [x] Perform desktop/mobile portrait/mobile landscape, keyboard, reduced
      motion, operational-state, CSS-isolation, and visual-fidelity QA. Try the
      in-app Browser first; record its exact unavailable reason if fallback is
      required.
- [x] Dispatch independent code/contract and browser/cutover reviews. Cover
      every Critical/Important finding with RED/GREEN proof and rerun fresh exit
      validation after the final fix.
- [x] Update this plan, parent plan, migration register, and fidelity ledger
      with commits, actual counts, cutover evidence, the exact configured-live
      result, and remaining risks. Mark `runner.distributed-monitor` code-backed
      only if all core proofs pass; keep owning legacy rows visible and uncut.
- [x] Commit `docs: record live recipe monitor exit` (fulfilled atomically by
      the commit containing this exit record).

**Fresh exit evidence (2026-07-12):** the exact nine-file focused slice passes
229/229; the complete app suite passes 708/708 across 72 files; shared-test and
app TypeScript checks pass; the production build transforms 507 modules; and
the reciprocal experience-closure assertion identifies separate Recipe
Console and Legacy Experience chunks. The complete Recipe Console Chromium
configuration passes 100 with one configured-live skip. The exact preserved
legacy navigation/ticket pair passes 28/28. Control-server check and 57/57
Deno tests pass. The no-service full-stack wrapper exits successfully with
exactly one skip for:
`Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
apps/rallar-black-box-control-server, and apps/rallar-black-box available.`

Desktop, 900px tablet, 430×932 portrait, and 932×430 landscape QA covers
keyboard-only evidence and Cancel paths, 44px targets, focus trap/restore,
reduced motion, announcements, zero document overflow, bounded matrix/action
scrolling, live Monitor CSS in both load orders, and all four controlled
Direction A baselines. The in-app Browser was attempted first and was
unavailable exactly as `No browser is available`; controlled
Playwright/System Chromium is fallback evidence, not an in-app Browser pass.
Independent review found seven Important issues: two full-stack false-proof
paths, selected-run legacy handoff, mobile visual/DOM focus order,
authoritative reconnect truth, short-landscape overflow, and keyboard-only
initiation evidence. Every finding received RED/GREEN coverage; final
code/contract, browser, and cutover re-reviews report no remaining Critical or
Important issue. No primary route, legacy visibility, legacy mount policy,
default, public export, or control contract changed.

## Exact Focused Validation

```bash
npx vitest run \
  packages/tests/rallar-black-box/distributed-recipes.test.ts \
  packages/tests/rallar-black-box/recipe-console-monitor-state.test.ts \
  packages/tests/rallar-black-box/recipe-console-monitor-action-policy.test.ts \
  packages/tests/rallar-black-box/recipe-console-control-query.test.ts \
  packages/tests/rallar-black-box/recipe-console-control-selection.test.ts \
  packages/tests/rallar-black-box/recipe-console-control-api.test.ts \
  packages/tests/rallar-black-box/recipe-console-structure.test.ts \
  packages/tests/rallar-black-box/recipe-console-seeded-state.test.ts \
  packages/tests/rallar-black-box/recipe-console-url-state.test.ts
npx vitest run \
  packages/tests/rallar-black-box/full-stack-api-server-mode.test.ts \
  packages/tests/rallar-black-box/recipe-console-full-stack-monitor.test.ts \
  packages/tests/rallar-black-box/legacy-run-url-selection.test.ts \
  packages/tests/rallar-black-box/app-structure.test.ts
npm --workspace @ar-eye-hunter/shared-test run check:ts
npm --workspace rallar-black-box run typecheck
npm --workspace rallar-black-box run build
npx tsx apps/rallar-black-box/scripts/assert-experience-chunks.ts
npx playwright test --config apps/rallar-black-box/playwright.recipe-console.config.ts \
  tests/playwright/rallar-black-box/recipe-console-monitor.spec.ts \
  tests/playwright/rallar-black-box/recipe-console-legacy-monitor-handoff.spec.ts
npx playwright test --config apps/rallar-black-box/playwright.full-stack.config.ts \
  tests/playwright/rallar-black-box/full-stack-recipe-console-monitor.spec.ts
npm run test:e2e:rallar-black-box:full-stack:real:distributed
```

## Iteration 5 Exit Criterion

For a running or failed selected distributed run, the first visible Monitor
region states the outcome, affected identity, and next inspection. Failures are
before raw events; every available correlation opens; last-known evidence stays
visible and honestly labelled across refresh failures; Cancel and artifact
operations use current credential-aware control truth; old deep links and both
legacy workflow rows remain operational. The configured live lifecycle is
passed only when services actually run it, otherwise it is recorded as skipped
with the exact reason above.

**Exit verdict:** satisfied for every available code-backed criterion. A
running or failed run answers outcome, affected identity, and next inspection
first; failure rows precede raw evidence; every available destination opens;
last-known evidence remains visible but blocks mutations; Cancel and artifact
operations remain bound to current credential-aware truth; and the exact
legacy run handoff works with multiple runs. `runner.distributed-monitor` is
code-backed, but `runner.runs` and `legacy.distributed-recipes` remain visible,
deep-linkable, uncut owners for later history/import/analysis/compare/
diagnostic/authoring work. Ready-State #4 and #5 are satisfied. Ready-State #3
remains open because the configured Postgres lifecycle was skipped rather than
executed.
