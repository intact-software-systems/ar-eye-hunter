# Recipe Console Timing And Tuning Lab Implementation Plan

Status: Iteration 7 in progress; Task 0 complete, Tasks 1–8 pending
Date: 2026-07-12
Parent: `playground/rallar-black-box-spa-reimplementation-plan.md`

## Objective

Replace the seeded Tune preview with an evidence-backed, bounded workspace that
turns distributed-run command timing and RTC stream health into explicit tuning
decisions. A user must be able to determine whether to lower cadence, raise an
ACK/barrier timeout only after readiness is clean, adjust an exact stream
threshold, fix target readiness, or investigate a specific agent. Candidate
changes are deliberate, validated, copyable output; the SPA never mutates a
recipe or calls a mutation endpoint from Tune.

This iteration also supplies the bounded comparison plane required by the
parent Iteration 7 goal and Ready-State #8. Iteration 8 still owns history,
saved filters, retention preview/cleanup, and the broader repeated-workflow
cut. No legacy surface is hidden or re-homed in Iteration 7.

## Repository Truth And Critical Review

- `TunePreview` always renders the `high-latency-rtc` seed and explicitly says
  RTC stream evidence is unavailable. It does not consume control or imported
  artifact truth.
- `DistributedRunPerformanceAnalysis` already contains command min/P50/P95/
  P99/max, average/spread/outliers, command slowest agents, RTC frame
  disposition, requested/achieved rates, drift, late frames, backpressure,
  send-duration percentiles, and stream slowest agents. Its current derivation
  is private to artifact analysis and will receive an additive public wrapper.
- Artifact snapshot normalization currently rebuilds a narrowed manifest and
  drops root tuning truth such as `ackTimeoutMs` and `barrier`. That drift must
  receive RED/GREEN coverage before Tune treats normalized snapshots as knob
  authority.
- `compareDistributedRuns(...)` already owns recipe/profile, participant,
  failure, timing, and received-message deltas. Its behavior and public
  signature remain unchanged.
- A distributed manifest may contain inline recipes or reference-only recipe
  IDs. Inline recipe commands nest through `loop.commands`,
  `parallel.groups[].commands`, and embedded `recipe.load`/`recipe.run`
  recipes. Reference-only recipes do not contain authoritative editable knobs.
- `validateDistributedRunManifest(...)` composes manifest schema/contract
  validation. `validateRallarBlackBoxRecipeCompatibility(...)` is the
  repository-authoritative recursive recipe/schema validator. Tune candidate
  validation must use both, then the corrected agent validator and distributed
  preflight; it must not rely on the narrower command validator alone.
- The agent command validator currently omits schema-supported loop
  `thresholds` from its allowed keys. Candidate validation must close that
  additive acceptance drift with a focused regression rather than emitting a
  patch that schema validation accepts but the agent rejects.
- `useAnalyzeWorkspace` retains exactly one bounded artifact model above the
  unmounted Analyze view. Tune may read that model; it must not create another
  artifact store or silently double the memory envelope.
- The root control provider owns the one serialized snapshot query. Tune may
  derive from it but must not fetch, poll, export, or create a second transport
  owner.
- The v1 URL codec already owns `compareLeft`, `compareRight`, and
  `timingMetric`. Comparison and metric changes use the existing history API;
  no new URL field or local-storage contract is needed.
- `RecipeConsoleWorkspace.tsx` is 219 lines against a 220-line specific gate,
  while all Recipe Console source owners are globally required to remain below
  300 lines. Iteration 7 removes seed and Tune-inspector ownership from the
  root rather than adding Tune logic to it.
- The baseline focused six-file slice passes 118/118, shared-test and SPA
  TypeScript checks pass, and the worktree is clean at `20e1df5`.

## Binding Decisions

1. Tune has one focus/candidate authority: `focusRunId = compareRight ??
   distributedRunId`. Selecting a committed right run atomically aligns
   `compareRight`, `distributedRunId`, and that run's `controlRunId`; left
   selection changes only `compareLeft`. Inspector content, candidate state,
   source provenance, and legacy handoff all bind to the resolved focus pair.
2. Detailed Tune authority is the retained artifact only when its distributed
   identity matches the focus run. Unsupported/future-schema or context-error
   artifacts may expose inspectable metrics with provenance, but cannot
   authorize candidate patch output or threshold-loosening. Otherwise use the
   selected root control snapshot and label its bounded evidence limitations.
   A mismatched retained artifact remains visible as stale context, never
   current truth.
3. Comparison inputs are explicit. Do not invent a "previous" run, silently
   select the newest run, or rewrite invalid/same-run selections. Show a clear
   issue and preserve every valid URL field.
4. Compatibility is advisory because the shared comparison helper deliberately
   accepts arbitrary run pairs. Show group/shared-recipe warnings while keeping
   the existing comparison output additive and available.
5. Candidate changes target one exact manifest JSON Pointer at a time. Values
   come from deliberate operator input. Hints recommend a direction and
   evidence, not an invented magic number.
6. Never recommend raising `maxInFlight` merely because backpressure exists.
   Drops/backpressure prefer lower load or cadence; `maxInFlight` remains an
   inspectable conditional knob.
7. Target/readiness blockers suppress timeout or threshold-loosening advice.
   Clean ACK/barrier timeout evidence may recommend a deliberate timeout
   candidate; isolated latency points to the specific agent.
8. Aggregate requested Hz is evidence, not a blanket edit. Exact knob hints
   are emitted only when structural evidence resolves one recipe/command
   pointer. Aggregate multi-stream or duplicate-command evidence returns every
   candidate path plus an ambiguity warning and suppresses an automatic knob
   recommendation.
9. Candidate previews clone and validate the manifest, return deterministic
   RFC 6902-style `add`/`replace` operations plus a readable diff, and prove the
   deeply frozen source stays unchanged. A missing or disabled barrier is
   non-editable rather than silently enabled; a missing RTC `thresholds` parent
   is materialized by one ordered parent operation before leaf adds. The
   emitted patch must apply to the source and deep-equal the returned clone. No
   Tune code imports an execution API.
10. Unsafe, oversized, control-character, or malformed-Unicode artifact/run
    identities remain inspectable but are quarantined from v1 comparison
    fields, legacy handoff URLs, filenames, and React keys using the existing
    Analyze identity policy.
11. Direction A remains the visual contract: current verdict/decision and
   timing health precede dense detail; comparison, knobs, and raw patch output
   remain progressively disclosed but keyboard-operable.
12. `runner.compare`, legacy Runs, and legacy Distributed Recipes stay visible,
    deep-linkable, and uncut until the complete documented replacement proofs
    pass. Tune includes an exact selected-run legacy Runs handoff.

## Canonical Acceptance Evidence

- Ready-State #7:
  `tests/playwright/rallar-black-box/recipe-console-tune.spec.ts` —
  `shows command percentiles cadence drift drops and backpressure for an RTC stream`.
- Ready-State #8 bounded comparison plane:
  `tests/playwright/rallar-black-box/recipe-console-tune.spec.ts` —
  `compares two runs across recipe participant failure timing and receive deltas`.
- Migration-register candidate proof:
  `tests/playwright/rallar-black-box/recipe-console-tune.spec.ts` —
  `compares two runs and emits explicit candidate timing changes without mutation`.

## Task 0: Lock Scope, Baseline, And Architecture

- [x] Critically inspect the parent plan, product contract, migration row,
  current Tune seed, retained Analyze model, root control/query boundary,
  shared performance/comparison contracts, validators, URL history, structure
  gates, and browser fixture owners.
- [x] Record the binding decisions above, including explicit comparison,
  one-artifact memory authority, advisory compatibility, operator-entered
  values, and readiness-first hint precedence.
- [x] Run the 118/118 focused baseline plus shared-test/app typechecks.
- [x] Dispatch independent shared-contract and app/browser plan reviews; close
  every Critical or Important issue before implementation.
- [ ] Commit this implementation plan and the parent/register in-progress
  checkpoint before behavior code.

## Task 1: Lock Canonical Browser RED Before Implementation

- [ ] Create bounded Tune browser data/fixture helpers and
  `tests/playwright/rallar-black-box/recipe-console-tune.spec.ts` with all three
  exact acceptance names before shared or React implementation.
- [ ] Build one real RTC stream envelope imported through visible Analyze and a
  two-run cross-control snapshot fixture with an actual recipe/profile delta,
  participant delta, failure delta, run-duration delta, and received-message
  delta. Each legacy run-detail endpoint remains operable after handoff.
- [ ] Capture the expected seed-era RED: the stream test lacks real RTC health,
  the comparison test lacks explicit URL-backed categories, and the candidate
  test lacks validated copy/no-mutation output. Record unrelated fixture/setup
  failures separately and do not count them as the intended RED.

## Task 2: Expose Snapshot Performance And Inventory Exact Knobs

Files:

- Add `packages/shared-test/rallar-bb-test/distributed-run-tuning.ts`
- Modify `packages/shared-test/rallar-bb-test/distributed-artifact-analysis.ts`
- Modify `packages/shared-test/rallar-bb-test/distributed-artifact-workspace.ts`
- Modify `packages/shared-test/rallar-bb-test/control-protocol.ts`
- Modify `packages/shared-test/rallar-bb-test/mod.ts`
- Add `packages/tests/rallar-black-box/distributed-recipe-tuning.test.ts`
- Modify focused public-surface/analysis tests only when additive exports require it

- [ ] RED-test the additive snapshot performance wrapper against artifact
  derivation for command and RTC stream evidence, including absent/partial
  results without invented values.
- [ ] RED-test deterministic knob inventory for manifest ACK/barrier values;
  inline root, loop, parallel-group, and embedded-recipe commands; JSON Pointer
  escaping; duplicate command IDs; optional/missing values; effective
  `intervalMs` precedence over shadowed `rateHz`; and stable order.
- [ ] Inventory `rateHz`, `durationMs`, `intervalMs`, `maxInFlight`,
  `ackTimeoutMs`, `barrier.timeoutMs`, and every numeric RTC stream threshold.
  Each row carries recipe/command identity, kind, exact pointer, current value,
  numeric constraint, and source limitation. Optional values render their
  current value as visibly unset rather than invented.
- [ ] RED-test that loose/envelope normalization preserves recognized raw
  manifest tuning fields while still enforcing normalized run/control
  identities and required structure.
- [ ] RED-test and fix the agent validator's additive loop-threshold drift so a
  schema-supported loop recipe passes schema, manifest, agent, and preflight
  validation after an unrelated candidate edit.
- [ ] Represent reference-only recipes as explicit limitations. Do not import
  app models, resolve repository fixtures implicitly, or invent current values.
- [ ] Preserve every existing public export and compare/control contract.

## Task 3: Validate Deliberate Candidate Changes Without Mutation

- [ ] RED-test exact-path candidate creation, JSON Pointer escaping,
  deterministic operation/diff order, add versus replace, integer/finite/range
  rejection, unknown path rejection, stale expected values, duplicate changes,
  missing-threshold-parent materialization, disabled/missing-barrier blocking,
  and multiple overlapping changes.
- [ ] RED-test recursive recipe compatibility plus manifest validation errors
  and prove a deeply frozen source manifest is unchanged on success and error.
- [ ] Return a typed result containing cloned candidate manifest, copyable JSON
  Patch, readable manifest diff, and file/path-specific validation issues.
- [ ] Apply every emitted patch in tests and require deep equality with the
  returned clone, including an absent `thresholds` parent and multiple changes
  sharing one newly materialized parent.
- [ ] Keep candidate helpers pure and deterministic. No clock, random ID,
  clipboard, network, filesystem, or React dependency enters shared-test.

## Task 4: Derive Evidence-Backed Tuning Hints And Performance Deltas

- [ ] RED-test target/readiness-first precedence across missing, stale,
  offline, wrong-group, identity, and expected-participant blockers.
- [ ] RED-test lower-rate/cadence hints for drops, in-flight-limit drops,
  backpressure, and material cadence/drift degradation without recommending a
  blind `maxInFlight` increase.
- [ ] RED-test clean ACK and barrier timeout evidence, stream threshold
  adjustment evidence, and isolated slow-agent evidence with exact affected
  agent and knob paths when available.
- [ ] RED-test insufficient/partial evidence, reference-only recipes, clean
  runs, multiple streams, duplicate command IDs, multiple equal slow agents,
  pointer ambiguity, and deterministic priority/order.
- [ ] Hints cite shared analysis categories and numeric evidence, state why the
  action is appropriate, and identify the next exact knob or agent inspection.
- [ ] Add a narrow deterministic performance comparison for the selected
  `timingMetric` and RTC frame/cadence/drift/drop/backpressure evidence. Compose
  it beside, never instead of or inside, the unchanged public
  `compareDistributedRuns(...)` structural summary.

## Task 5: Build Pure Tune Source, Selection, And Comparison Models

Files:

- Add focused pure owners under `apps/rallar-black-box/src/recipe-console/tune/**`
- Add `packages/tests/rallar-black-box/recipe-console-tune-model.test.ts`
- Add `packages/tests/rallar-black-box/recipe-console-tune-selection.test.ts`
- Modify URL/history tests only to cover previously unexercised restoration

- [ ] RED-test retained matching artifact authority, mismatched retained
  artifact warning, unsupported/future-schema candidate blocking, selected
  live/partial/stale control truth, bounded control provenance, reference-only
  limitation, missing performance, and no-evidence state.
- [ ] RED-test explicit left/right lookup, same-run and invalid IDs, control-run
  pairing, atomic right/focus/control alignment, left-only patching,
  artifact/control de-duplication, deterministic option order, compatibility
  warnings, cross-control pairing, and every shared compare category.
- [ ] RED-test existing safe identity projection for oversized IDs, control
  characters, malformed Unicode, and unsafe retained evidence. Quarantined IDs
  never enter compare fields, legacy URLs, filenames, or React keys.
- [ ] Derive presentation models only from shared performance, hints,
  inventory, candidate, and compare helpers. Do not duplicate calculations in
  React or import seeded diagnostics.
- [ ] Keep URL patch helpers pure: run/comparison/metric changes push through
  the existing v1 history contract and clear only dependent state.

## Task 6: Replace Tune Preview With Bounded Lazy Signal Ledger Composition

Files:

- Add `TuneWorkspace`, source/selection, command timing, stream health,
  slow-agent, hint, knob/candidate, comparison, and inspector owners under
  `src/recipe-console/tune/**`
- Add focused CSS Modules under the same directory
- Modify `RecipeConsoleWorkspace.tsx` and `RecipeConsoleActiveWork.tsx`
- Remove `TunePreview`, `TimingDistribution`, their CSS, and Tune seed types/data
- Remove or replace `recipe-console-seeded-state.test.ts` and seed-specific
  structure assertions with no-seed and lazy-Tune gates

- [ ] RED-test root composition before React changes: one `TuneWorkspace`, no
  Tune seed/model/import, no root Tune state machine, and all source owners
  below structure caps.
- [ ] Load Tune through a local `React.lazy`/Suspense route boundary. Prove its
  production chunk is absent from inactive Recipe Console views and the Tune UI
  is unmounted when inactive; root Analyze/control services remain the only
  view-independent state owners.
- [ ] Render command min/P50/P95/P99/max, average/spread/outliers and slowest
  agents; stream planned/scheduled/attempted/completed/failed/dropped/in-flight
  drops, requested/achieved Hz, drift, late frames, backpressure, duration
  percentiles, and slowest stream agents.
- [ ] Render decision-first hints, exact knob current values/paths, deliberate
  candidate input, validation, copyable patch/diff, truthful clipboard status,
  and unchanged-source evidence. Candidate state resets only when the resolved
  source fingerprint (identity, generated/updated time, or current knob truth)
  changes; root Refresh preserves it for an unchanged source. No action mutates
  or calls Control.
- [ ] Render explicit baseline/candidate selectors and all recipe, participant,
  failure, timing, and received-message deltas with compatibility warnings.
- [ ] Render honest empty, partial, stale, mismatch, reference-only, invalid
  comparison, same-run, and unavailable-metric states.
- [ ] Route one contextual inspector through the existing shell callback;
  preserve focus trap/restore, selection dock, 44px targets, and the exact
  legacy Runs handoff built from the resolved candidate's own control/run IDs.

## Task 7: Turn Canonical RED Green And Complete Browser QA

- [ ] Turn the three Task 1 canonical RED tests green without weakening their
  visible-control, exact-category, copy, or no-request assertions.
- [ ] Import a real RTC stream artifact through visible Analyze controls,
  navigate to Tune, and prove frame disposition, P95/P99, cadence, drift,
  drops, in-flight drops, backpressure, a specific slow agent, and a sourced
  tuning hint.
- [ ] Prove an exact knob edit produces valid copyable patch/diff output while
  source value and request counts remain unchanged.
- [ ] Compare two explicit runs, reload/copy/back/forward the v1 URL, and prove
  every shared delta category, the selected performance delta, atomic focus
  alignment, plus invalid/same-run/compatibility states.
- [ ] Prove no artifact or mutation request is made by Tune and activate the
  exact selected-run legacy Runs destination.
- [ ] Cover 1440×900, 900×900, 430×932, and 932×430; keyboard-only selection,
  metric, agent, knob, candidate, compare, copy, inspector, and handoff paths;
  focus restore/Escape; 44px targets; reduced motion; announcements; zero
  document overflow; and actual Tune CSS under both legacy load orders.
- [ ] Refresh the approved Direction A Tune baseline only after semantic and
  geometry assertions pass. Replace the concept test's empty Tune control seed
  with deterministic real evidence, then inspect the durable image at original
  detail.

## Task 8: Fresh Exit, Review, Documentation, And Milestone Commits

- [ ] Run the focused validation contract below after every implementation
  slice and the complete app/Recipe Console suites after the last fix.
- [ ] Run shared/app typechecks, production build, reciprocal experience-chunk
  assertion, exact preserved legacy navigation/ticket pair, and control-server
  tests if a shared contract changes their expectations.
- [ ] Try the in-app Browser first; if unavailable, record the exact reason and
  use controlled Playwright/System Chromium without calling it an in-app pass.
- [ ] Dispatch independent shared-contract, app/state, browser/accessibility,
  and cutover reviews. Add RED/GREEN proof for every Critical or Important
  finding and rerun fresh validation.
- [ ] Update this plan, parent plan, product spec, migration register, and
  fidelity ledger with actual commits, counts, Ready-State evidence, skips,
  compatibility decisions, cutover status, and remaining risks.
- [ ] Mark Ready-State #7 and the bounded #8 comparison plane code-backed only
  after their exact tests pass. Keep Iteration 8 history/retention work open.
- [ ] Keep `runner.runs`, `runner.compare`, and
  `legacy.distributed-recipes` visible and uncut; commit cohesive green
  milestones locally and do not push or open a PR.

## Focused Validation Contract

```sh
npx vitest run \
  packages/tests/rallar-black-box/distributed-recipes.test.ts \
  packages/tests/rallar-black-box/distributed-artifact-analysis.test.ts \
  packages/tests/rallar-black-box/schema-authoring.test.ts \
  packages/tests/rallar-black-box/distributed-recipe-tuning.test.ts \
  packages/tests/rallar-black-box/recipe-console-tune-model.test.ts \
  packages/tests/rallar-black-box/recipe-console-tune-selection.test.ts \
  packages/tests/rallar-black-box/recipe-console-url-state.test.ts \
  packages/tests/rallar-black-box/recipe-console-url-history.test.ts \
  packages/tests/rallar-black-box/recipe-console-structure.test.ts
npm --workspace @ar-eye-hunter/shared-test run check:ts
npm --workspace rallar-black-box run typecheck
npm --workspace rallar-black-box run build
npx tsx apps/rallar-black-box/scripts/assert-experience-chunks.ts
npx playwright test \
  --config apps/rallar-black-box/playwright.recipe-console.config.ts \
  tests/playwright/rallar-black-box/recipe-console-tune.spec.ts \
  tests/playwright/rallar-black-box/recipe-console-history.spec.ts \
  tests/playwright/rallar-black-box/recipe-console-responsive-accessibility.spec.ts \
  tests/playwright/rallar-black-box/recipe-console-css-isolation.spec.ts \
  tests/playwright/rallar-black-box/recipe-console-concept-fidelity.spec.ts
```

The complete `packages/tests/rallar-black-box` suite, complete Recipe Console
Playwright configuration, and exact legacy tabbed-navigation/agent-ticket pair
are mandatory at exit. Live services are not required for the deterministic
Iteration 7 acceptance. Any configured-service owner that is unavailable is
reported as skipped with its exact reason and is never counted as passed.
