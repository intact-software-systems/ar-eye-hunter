# Rallar Recipe Console Monitor Workflow Implementation Plan

Status: Iteration 5 execution plan; implementation not yet started
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

- [ ] RED-test role-scoped expected agents using resolved assignments,
  manifest assignments, `recipeIds`, and role-only selections; prove no sibling
  role is falsely counted missing.
- [ ] RED-test selected-failure evidence destinations for first and later run,
  participant, recipe, command, and composite failures. Agent, recipe, command,
  direct diagnostics, matching timeline/events, and valid artifact destinations
  appear only when available.
- [ ] Implement narrow deterministic helpers without changing existing
  signatures or exports. Additive public exports remain available from both
  shared-test and the app compatibility barrel.
- [ ] Pass focused shared tests and shared-test TypeScript checks.
- [ ] Commit `fix: derive role-aware distributed monitor evidence`.

## Task 2: Reconcile Coherent Monitor State And Policies

Files:

- Create `apps/rallar-black-box/src/recipe-console/monitor/monitor-workspace-state.ts`
- Create `apps/rallar-black-box/src/recipe-console/monitor/monitor-workspace-model.ts`
- Create `apps/rallar-black-box/src/recipe-console/monitor/monitor-selection.ts`
- Create `apps/rallar-black-box/src/recipe-console/monitor/monitor-action-policy.ts`
- Create `packages/tests/rallar-black-box/recipe-console-monitor-state.test.ts`
- Create `packages/tests/rallar-black-box/recipe-console-monitor-action-policy.test.ts`
- Modify `packages/tests/rallar-black-box/recipe-console-control-selection.test.ts`

- [ ] RED-test no selection, sole-run canonicalization, explicit unavailable and
  incompatible IDs, multiple-run ambiguity, and run-selection dependency
  clearing.
- [ ] RED-test complete current evidence, total stale/offline preservation,
  partial distributed-context preservation, partial coherent replacement,
  authoritative deletion, recovery, newer mutation truth, and context-change
  clearing. Never mix unrelated run/control snapshots.
- [ ] RED-test artifact pending/success/failure retention, identity mismatch,
  operation generations, and abort-resistant stale response rejection.
- [ ] RED-test Cancel/Load/Export policies across live, partial, stale, offline,
  authorization, credential-trust, non-terminal, terminal, busy, armed, and
  unarmed states.
- [ ] Derive monitor/report/verdict once per coherent source, with
  `RECIPE_CONSOLE_CONTROL_SNAPSHOT_BOUNDS` supplied to analysis.
- [ ] Pass focused state/policy/selection tests and app typecheck.
- [ ] Commit `feat: reconcile live monitor workspace truth`.

## Task 3: Bind Root Control Operations

Files:

- Create `apps/rallar-black-box/src/recipe-console/monitor/use-monitor-workspace.ts`
- Create `apps/rallar-black-box/src/recipe-console/monitor/use-monitor-operations.ts`
- Create `apps/rallar-black-box/src/recipe-console/control/ControlRunCancelDialog.tsx`
- Create `apps/rallar-black-box/src/recipe-console/control/ControlRunCancelDialog.module.css`
- Modify `apps/rallar-black-box/src/recipe-console/execute/ExecuteCancelDialog.tsx`
- Modify `apps/rallar-black-box/src/recipe-console/execute/ExecuteCancelDialog.module.css`
- Modify `packages/tests/rallar-black-box/recipe-console-structure.test.ts`

- [ ] RED-test structural ownership: no Monitor fetch/timer/legacy imports,
  bounded owners, no seeded Monitor dependencies, root execution adapter only,
  and shared confirmation ownership without Execute-to-Monitor coupling.
- [ ] Bind Refresh, Cancel, Load artifact, and Export to the current context.
  Abort on route/context changes, check context again after every await, retain
  same-run artifact on load failure, download deterministic content/filename,
  project successful Cancel, and queue `refreshAfterCurrent()`.
- [ ] Extract the accessible focus-trapped Cancel confirmation behind a narrow
  control-level component while preserving Execute behavior and selectors.
- [ ] Pass focused operation/structure/Execute regression tests and typecheck.
- [ ] Commit `feat: bind live monitor control operations`.

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

- [ ] Add structure and model RED assertions before React implementation.
- [ ] Render current/last-known provenance, run selection, verdict, affected
  identity, next action, failures, agent × phase matrix, recipe progress, ACK
  and barrier readiness, diagnostic counts/filtering, artifact status, and
  bounded timeline/event/composite evidence in failure-first order.
- [ ] Make every available correlated evidence destination operable. Update
  agent/recipe/command URL state and restore it through reload/back/copy.
- [ ] Preserve the 360px desktop inspector, tablet overlay, portrait dock/sheet,
  landscape split, keyboard selection, focus trap/restore, 44px targets,
  reduced motion, announcements, and contained scrolling.
- [ ] Render honest empty, loading, current, partial, stale, offline,
  authorization, credential-trust, running, waiting ACK/barrier, ready, passed,
  failed, timed-out, cancelled, artifact missing/invalid, and recovered states.
- [ ] Remove only seeded Monitor ownership; keep Tune's deterministic seed
  isolated. Keep both legacy workflow rows visible and uncut.
- [ ] Pass focused unit/structure/browser RED→GREEN, typecheck, and build.
- [ ] Commit `feat: replace seeded monitor with live evidence`.

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

- [ ] Keep these acceptance names exact:
  `places the failure verdict and failure list before raw event evidence`;
  `opens all available correlated evidence from a failure row`;
  `preserves last-known evidence while a selected run refresh fails`; and
  `completes the configured live distributed run lifecycle and exports its artifact`.
- [ ] Prove a mocked one-agent failure, running/pass/fail/timeout/cancelled and
  reconnect transitions, complete/partial/stale/offline truth, Execute handoff,
  copied deep-link restoration, bounded secondary evidence, armed visible
  Cancel, artifact Load/Export, and abort-ignoring late responses.
- [ ] Prove desktop, tablet, 430×932 portrait, 932×430 landscape,
  keyboard-only paths, 44px targets, focus trap/restore, reduced motion,
  announcements, no document overflow, and actual Monitor CSS in both load
  orders. Refresh and inspect the approved Monitor baselines.
- [ ] Extend the configured Postgres acceptance through visible Monitor truth
  and a distinct live non-terminal cancellation. The full-stack wrapper must
  verify per-target cancel links and dispatched/completed `recipe.cancel`
  commands. If unavailable, skip for exactly:
  `Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
  apps/rallar-black-box-control-server, and apps/rallar-black-box available.`
- [ ] Commit `test: prove live monitor lifecycle and evidence`.

## Task 6: Fresh Exit, Review, And Documentation

- [ ] Run the exact focused unit list, complete app suite, shared-test check,
  app typecheck/build/chunk assertion, complete Recipe Console browser config,
  exact legacy navigation/ticket pair, control-server check/test, and the
  configured full-stack acceptance when services are available.
- [ ] Perform desktop/mobile portrait/mobile landscape, keyboard, reduced
  motion, operational-state, CSS-isolation, and visual-fidelity QA. Try the
  in-app Browser first; record its exact unavailable reason if fallback is
  required.
- [ ] Dispatch independent code/contract and browser/cutover reviews. Cover
  every Critical/Important finding with RED/GREEN proof and rerun fresh exit
  validation after the final fix.
- [ ] Update this plan, parent plan, migration register, and fidelity ledger
  with commits, actual counts, cutover evidence, the exact configured-live
  result, and remaining risks. Mark `runner.distributed-monitor` code-backed
  only if all core proofs pass; keep owning legacy rows visible and uncut.
- [ ] Commit `docs: record live recipe monitor exit`.

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
npm --workspace @ar-eye-hunter/shared-test run check:ts
npm --workspace rallar-black-box run typecheck
npm --workspace rallar-black-box run build
npx tsx apps/rallar-black-box/scripts/assert-experience-chunks.ts
npx playwright test --config apps/rallar-black-box/playwright.recipe-console.config.ts \
  tests/playwright/rallar-black-box/recipe-console-monitor.spec.ts
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
