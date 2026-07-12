# Rallar Recipe Console Large-Run Scale And Windowing Implementation Plan

Status: in progress; Iteration 8 is qualified through `fd9055e`, `f762749`,
and `37c7a32`; Task 0 is in progress

**Goal:** Complete parent Iteration 9 so large distributed artifacts and run
collections stay searchable and operable without blocking the browser or
mounting unbounded evidence DOM, satisfying Ready-State #10.

**Architecture:** Preserve all current public exports, control-server
contracts, artifact profiles, legacy routes, and the six-view information
architecture. Add an additive shared-test parsed-artifact pipeline and
deterministic cursor/window contracts. Run large Analyze derivation in a
feature-local worker. Use explicit accessible Previous/Next windows with native
list/table semantics for variable-height UI; window state is ephemeral and
bound to the current model/query fingerprint. Keep producer compaction, index
omission, and current render-window omission as distinct truth.

**Performance rule:** Static findings are hypotheses except for proven
algorithmic failures. Record before/after measurements under `tmp/perf/`, use
exact cardinality/DOM/parse-count/event-loop invariants in CI, and treat wall
time/heap/browser long-task measurements as same-machine advisory evidence.
No Canvas plot is added: Recipe Console has no dense plot whose profiling
justifies that accessibility cost.

## Binding Decisions

- The exact Ready-State owner is
  `tests/playwright/rallar-black-box/recipe-console-scale.spec.ts` —
  `keeps synthetic large event and result lists bounded responsive and searchable`.
- The canonical artifact contains 12,000 events and 3,000 results, with unique
  first/middle/last needles and actionable failures/diagnostics. A History
  fixture contains 5,000 run pairs. Files stay within existing intake limits.
- Analyze evidence mounts at most 64 rows per sampled state; History mounts at
  most 80 data rows. Windows traverse all retained matches without gaps or
  duplicates and report an exact `Showing a–b of n` range.
- Every other proven pressure list (run selectors, targets, participants,
  diagnostics, retention IDs, and Tune knobs) mounts at most 100 options/rows;
  a 2,000-command Tune fixture must keep an event-loop heartbeat progressing.
- Explicit accessible windows are the variable-height virtualization strategy.
  Do not introduce fixed-height spacer rows, absolute-positioned table rows, or
  a new third-party virtualizer.
- Existing `searchDistributedArtifactEvidence(...)` and index limits keep their
  behavior. Add cursor/window APIs rather than silently changing public result
  shapes or merely raising caps.
- A generic `artifact-index.json` remains solely a legacy Shared Test artifact;
  its runner identity cannot be correlated authoritatively to a distributed
  run. Iteration 9 presents its compaction/truncation only in the preserved
  Shared Test importer and never mixes its counts into Analyze.
- The worker-retained evidence catalog ceiling is 20,000 entries. Overflow
  keeps the primary failure, latest diagnostic, then stable newest retained
  evidence; it reports exact index omissions and never invents omitted rows.
- Producer-compacted rows are summary-only and never claimed searchable;
  shared-index omissions make totals visibly incomplete; render-window rows
  remain browseable.
- Distributed artifacts have no authoritative producer-compaction contract, so
  Analyze explicitly reports producer compaction unavailable. Generic
  compaction truth is tested and displayed only in legacy Shared Test.
- Analyze worker telemetry is session-memory/DOM-performance-entry only:
  finite durations and exact counts, never IDs, queries, payloads, tokens,
  credentials, filenames, or artifact bytes. Nothing is persisted or sent.
- Control snapshot contracts remain unchanged. Iteration 9 adds no server
  cursor. If repository evidence later proves a server contract is necessary,
  stop for breaking/expansion review before changing it.
- No navigation row is hidden or cut over. `runner.runs`,
  `runner.distributed-monitor`, `runner.artifact-analysis`,
  `legacy.distributed-recipes`, and `legacy.shared-test-import` retain their
  current visibility, mount policy, deep links, and rollback URLs.
- Production scale acceptance runs against port 4176 so StrictMode replay does
  not distort render-count observations. Durations are recorded but not gated
  by absolute milliseconds in CI.
- The benchmark advisory rule is investigate and document any candidate median
  above 1.25× its same-machine base. It never auto-fails CI. With five measured
  runs, the reported "p95" is labeled approximate/max rather than statistical.

## Task 0: Freeze Baseline, Harness, Budgets, And Ownership

- [ ] Add a deterministic synthetic large distributed-artifact fixture and a
  read-only root `scripts/perf/rallar-recipe-console-scale-bench.ts` harness.
- [ ] Assert fixture byte size explicitly: every file <=16 MiB and aggregate
  <=48 MiB under the existing intake contract.
- [ ] Record warm-up plus five-run 500/2,000/15,000-row baseline measurements:
  model/search duration, pipeline/file/row parse counters, heap delta, and
  source/index/match counts.
- [ ] Persist commit, runtime, fixture bytes, flags, warm-up/run count, per-run
  samples, median, and approximate p95/max under `tmp/perf/results/**`. Invoke
  Node with `--expose-gc --import tsx` whenever heap delta is recorded.
- [ ] After the harness-only commit and before algorithm changes, run the fenced
  benchmark command with `--out=tmp/perf/results/iteration-9-base.json`; run the
  identical flags at Task 8 with `iteration-9-candidate.json`.
- [ ] Record 5,000 run-pair and 2,000-command Tune baselines, including global
  selection work, projected rows/options, mounted DOM, and heartbeat progress.
- [ ] RED-prove safe extrema with a portable 200,000-value correctness case,
  late evidence beyond the retained index is unsearchable, and current Monitor
  and History prefixes are not browseable.
- [ ] Capture the existing focused unit/app/browser/build/chunk baseline and
  exact configured-live skip/pass state.

## Task 1: Add One Parsed Artifact Pipeline And Safe Linear Primitives

- [ ] Add an additive parsed distributed-artifact representation under
  `packages/shared-test/rallar-bb-test/**`; reuse it for compatibility,
  snapshots, analysis, monitor/report, and evidence derivation.
- [ ] Preserve existing public functions as delegating compatibility surfaces.
- [ ] Replace externally sized spread extrema with single-pass reducers.
- [ ] Replace quadratic stream-sample equivalence scans with deterministic
  keyed buckets while preserving precedence and collision behavior.
- [ ] Reuse one derived Monitor/report where current pipelines recompute it.
- [ ] GREEN shared tests for exact old behavior, one source-file pass and at
  most one `JSON.parse` per JSON document/nonempty JSONL record in the new
  pipeline, 200k-value safety, stable output, and linear-work counters.
- [ ] Telemetry distinguishes `pipelinePassCount`, JSON document parses, JSONL
  file passes, and nonempty JSONL row parses; no aggregate "parse count" may
  conceal repeated source scans.
- [ ] Measure the same harness before/after; accept only with correctness green
  and no material regression in the target large workload.

## Task 2: Add Deterministic Cursor/Window And Compaction Contracts

- [ ] Add opaque artifact/model/query-bound cursor and explicit window types in
  shared-test. Reject stale, foreign, malformed, and tampered cursors.
- [ ] Traverse retained evidence in stable source/order semantics with no gaps
  or duplicates; filter changes reset the cursor.
- [ ] Keep current search API unchanged and add a full retained-catalog search
  window API with an explicit hard bound and exact upstream omission truth.
- [ ] GREEN shared tests for first/middle/last needles, exact totals, all cursor
  boundaries, the 20,000-entry ceiling/retention policy, three distinct
  omission classes, and standalone generic handoff.

## Task 3: Move Analyze Derivation And Search Off The Blocking Main Thread

- [ ] Add a focused `src/recipe-console/analyze/**` lifetime worker and typed
  request/response adapter; keep it lazy to Analyze import/load and absent from
  the eager shell.
- [ ] Keep raw/parsed files, the full evidence catalog, search haystacks, and
  cursor execution worker-owned. The main thread receives only compact summary,
  analysis/quality/performance projections, the current <=64-row window, and
  the selected evidence projection—not duplicate artifact strings/snapshots.
- [ ] Export/reimport bytes on demand through a Blob or transferable buffer;
  never structured-clone accepted 48 MiB strings back and forth per operation.
- [ ] Separate in-flight candidate and accepted artifact lifetimes. Abort/
  terminate a candidate on authority loss; keep the accepted worker across
  Analyze→Tune and ordinary view/context changes until Clear, replacement,
  Recipe Console unmount, crash, or explicit disposal.
- [ ] Retain one exportable Blob/transferable envelope outside the worker so
  accepted export remains available without a second Control request even if
  the worker fails. Handle `error`, `messageerror`, and unexpected exit with
  last-usable bounded projection truth.
- [ ] Reuse existing operation authority: validate Control identity before
  accepting the candidate and patch the URL only after accepted completion.
- [ ] Expose an on-demand bounded Tune facade containing manifest, focused/
  compared-run truth, tuning inventory/candidate inputs, and received-message
  deltas without raw event/result arrays.
- [ ] Return only bounded clone-safe projections plus numeric telemetry. Errors
  cross a typed secret-free boundary.
- [ ] Emit local performance measures for parse/model/search and DOM attributes
  for source/index/match/mounted/render counts.
- [ ] Make responsiveness deterministic: worker posts `accepted`; adapter paints
  pending on the next rAF; only then it sends `start`. Assert protocol order
  `accepted → pending-painted/start → complete`. Use a controllable fake to
  prove input/navigation during held search/window replies; real-browser proof
  asserts the actual worker asset/request.
- [ ] Give build/search/window requests monotonically generated authority.
  Query A→B and window N→N+1 must suppress late A/N responses, selection, and
  telemetry.
- [ ] GREEN Analyze→Tune→Analyze, compare/candidate, export-after-navigation,
  candidate rejection, worker crash/disposal, and stale search/window tests.
  Telemetry is finite, exact, token/payload-free, non-persistent, and clears/
  bounds performance entries so they cannot grow per search.

## Task 4: Add Reusable Accessible Window Controls

- [ ] Add bounded UI/model owners under `src/recipe-console/ui/**`; do not grow
  a global registry or stylesheet.
- [ ] Render native list/table children for one explicit range with
  Previous/Next, range/total, disabled boundaries, aria-live announcements,
  and deterministic reset on fingerprint change.
- [ ] Preserve focus when the active row stays in range; return focus to the
  range control when a row leaves the mounted window.
- [ ] Meet 44px touch targets, reduced motion, RTL/bidi-safe exact identifiers,
  short-landscape containment, and keyboard operation.
- [ ] GREEN focused model/component tests before composing feature UI.

## Task 5: Window Analyze Search Without Losing Late Evidence

- [ ] Compose shared full-catalog search windows in Analyze while preserving
  v1 URL filters and existing inspector selection semantics.
- [ ] Find exact last-event and last-result needles beyond the former 500-entry
  cap and browse every retained match with at most 64 mounted rows.
- [ ] Display producer-compacted, index-omitted, matching, and render-window
  states separately. Analyze says producer compaction is unavailable; never
  synthesize it from the 20,000-entry catalog cap or label omissions searchable.
- [ ] Keep result selection, inspector focus, local/control import, export/
  reimport, and legacy Shared Test handoff operational.
- [ ] GREEN unit plus real-browser tests for search, cursor reset, focus,
  telemetry, offline/error/partial/future-schema states, and CSS isolation.

## Task 6: Replace Monitor Prefix Caps With Browseable Windows

- [ ] Reuse one indexed Monitor/report/verdict derivation per snapshot and avoid
  repeated per-agent/per-recipe scans where proven by counters.
- [ ] Add reusable run-by-control/agent/command indexes for the always-on root
  control selection path; unchanged five-second polls must not repeat expensive
  global board/options work.
- [ ] Retain Analyze artifacts across views without sorting/filtering all run
  selector options while Analyze is inactive.
- [ ] Window events, timeline, composite results, diagnostics, failures,
  participant matrix, and recipe/readiness tables only where collections can
  exceed their existing visible bounds.
- [ ] Preserve failure-first order, selected evidence/inspector links,
  current/last-known truth, polling/action authority, and exact omission truth.
- [ ] GREEN tests that late events/results/agents are reachable, filters reset
  the correct window, no section mounts beyond its budget, and polling does not
  repeat unchanged expensive derivation. Include exact global-selection and
  inactive-Analyze work counters under 5,000 run pairs.

## Task 7: Window History, Retention Consequences, And Proven Pressure Lists

- [ ] Replace History's first-100 dead end with a 5,000-row deterministic
  window while preserving full-set counts, quarantine, Baseline/Candidate,
  saved filters, copied URLs, and cleanup reconciliation.
- [ ] Slice the History window before per-row label projection, Tune catalog/
  quarantine work, connected-agent scans, and action projection. Assert the
  expensive projected-row counter never exceeds the active window budget.
- [ ] Bound retention candidate/linked/global-ID DOM with explicit windows;
  exact server consequences and confirmation fingerprints remain unchanged.
- [ ] Profile and then window the proven 2,000-command Tune maximum, unbounded
  run selectors, and target collections to <=100 mounted options/rows while
  preserving catalog/selection semantics and event-loop heartbeat progress.
- [ ] Replace pressure-path native selects with an accessible searchable
  combobox/listbox window; native `<select>` children are not silently sliced.
  Build only cheap run identity indexes globally and derive Tune performance
  for the focused/compared pair, never every 5,000-run catalog entry.
- [ ] Present existing generic `artifact-index.json` compaction/truncation in
  `src/legacy/runner/shared-test/**` only; keep the generic handoff, identity,
  parsing, rollback route, and mount policy unchanged.
- [ ] GREEN `recipe-console-shared-test-compaction.test.ts` and exact browser
  `recipe-console-legacy-shared-test-compaction.spec.ts` — `shows bounded
  generic artifact compaction without changing the Shared Test fallback`.
- [ ] GREEN component/browser tests for last-window reachability, long exact IDs,
  keyboard/touch/focus, dialog safety, and no destructive-request regression.

## Task 8: Canonical Production Scale Acceptance And Profiling

- [ ] GREEN exact Ready-State #10 title against production port 4176.
- [ ] Assert 15,000 source rows, exact late needles, <=64 mounted Analyze rows,
  5,000 History pairs, <=80 mounted History rows, finite telemetry, one parsed
  representation with exact file/record counters, responsive search/window
  actions, and no document overflow.
- [ ] Assert <=100 mounted options/rows for 2,000-command Tune, run selectors,
  targets, Monitor pressure lists, and retention consequences; assert bounded
  global-selection/Tune-derivation and History-projection work counters plus
  heartbeat progress. Traverse first/middle/last evidence inside the exact test.
- [ ] Exercise desktop 1440x900, tablet 900x900, portrait 430x932, landscape
  932x430, keyboard, touch, reduced motion, operational states, both CSS load
  orders, lazy chunks, and unmount cleanup.
- [ ] Record five-run candidate measurements and compare model/search median,
  approximate p95-max, and heap/count signals to Task 0 without turning
  machine-dependent milliseconds into CI gates. Browser responsiveness is the
  deterministic accepted→paint→start/held-RPC protocol gate, not a synthetic
  long-task before/after claim.
- [ ] Record Canvas as deferred with measured reason unless the profile shows
  a real dense-DOM bottleneck requiring a separate accessible design.

## Task 9: Reviews, Fresh Exit, Documentation, And Milestone Commits

- [ ] Dispatch independent shared-algorithm/performance, worker/state,
  UI/accessibility/browser, and strangler/cutover reviews; RED/GREEN every
  Critical or Important finding.
- [ ] Run focused shared/app tests, complete app suite, shared/app TypeScript and
  Deno checks, build/chunk assertion, complete Recipe Console config, exact
  legacy navigation/ticket pair, and control-server tests if touched.
- [ ] Try the in-app Browser and record exact availability; report configured
  live/Postgres tests as skipped with the exact reason when unavailable.
- [ ] Update this plan, parent ledger/risks, product spec, migration register,
  and fidelity ledger with commits, counts, measurements, proof, skips,
  unchanged rollback/cutover status, and remaining Iterations 10–12 risks.
- [ ] Make cohesive local green milestone commits. Do not push or open a PR.

## Focused Validation Contract

```sh
npx vitest run \
  packages/tests/rallar-black-box/distributed-artifact-evidence.test.ts \
  packages/tests/rallar-black-box/distributed-artifact-analysis.test.ts \
  packages/tests/rallar-black-box/distributed-artifact-spa.test.ts \
  packages/tests/rallar-black-box/recipe-console-analyze-model.test.ts \
  packages/tests/rallar-black-box/recipe-console-analyze-file-boundary.test.ts \
  packages/tests/rallar-black-box/recipe-console-analyze-state.test.ts \
  packages/tests/rallar-black-box/recipe-console-analyze.test.ts \
  packages/tests/rallar-black-box/recipe-console-monitor-state.test.ts \
  packages/tests/rallar-black-box/recipe-console-history-model.test.ts \
  packages/tests/rallar-black-box/recipe-console-history-table-ui.test.ts \
  packages/tests/rallar-black-box/recipe-console-retention-cleanup.test.ts \
  packages/tests/rallar-black-box/recipe-console-retention-dialog.test.ts \
  packages/tests/rallar-black-box/recipe-console-retention-integration.test.ts \
  packages/tests/rallar-black-box/recipe-console-retention-panel.test.ts \
  packages/tests/rallar-black-box/recipe-console-tune-model.test.ts \
  packages/tests/rallar-black-box/recipe-console-tune-model-hardening.test.ts \
  packages/tests/rallar-black-box/distributed-recipe-tuning-hardening.test.ts \
  packages/tests/rallar-black-box/recipe-console-shared-test-compaction.test.ts \
  packages/tests/rallar-black-box/recipe-console-structure.test.ts

npm --workspace @ar-eye-hunter/shared-test run check:ts
npm --workspace @ar-eye-hunter/shared-test run check:deno
npm --workspace rallar-black-box run typecheck
npm --workspace rallar-black-box run build
npx tsx apps/rallar-black-box/scripts/assert-experience-chunks.ts

# Task 0 only; the harness refuses to overwrite this baseline.
node --expose-gc --import tsx \
  scripts/perf/rallar-recipe-console-scale-bench.ts \
  --sizes=500,2000,15000 --warmup=1 --runs=5 \
  --out=tmp/perf/results/iteration-9-base.json

# Task 8 only; compare without modifying the Task 0 baseline.
node --expose-gc --import tsx \
  scripts/perf/rallar-recipe-console-scale-bench.ts \
  --sizes=500,2000,15000 --warmup=1 --runs=5 \
  --out=tmp/perf/results/iteration-9-candidate.json

npx playwright test \
  --config apps/rallar-black-box/playwright.recipe-console.config.ts \
  tests/playwright/rallar-black-box/recipe-console-scale.spec.ts \
  tests/playwright/rallar-black-box/recipe-console-analyze.spec.ts \
  tests/playwright/rallar-black-box/recipe-console-analyze-safety.spec.ts \
  tests/playwright/rallar-black-box/recipe-console-analyze-handoff.spec.ts \
  tests/playwright/rallar-black-box/recipe-console-monitor.spec.ts \
  tests/playwright/rallar-black-box/recipe-console-history.spec.ts \
  tests/playwright/rallar-black-box/recipe-console-tune.spec.ts \
  tests/playwright/rallar-black-box/recipe-console-legacy-shared-test-compaction.spec.ts \
  tests/playwright/rallar-black-box/recipe-console-responsive-accessibility.spec.ts \
  tests/playwright/rallar-black-box/recipe-console-css-isolation.spec.ts \
  tests/playwright/rallar-black-box/recipe-console-chunks.spec.ts
```

Complete app and Recipe Console suites plus the preserved legacy pair remain
mandatory at exit. Configured live/Postgres work is unavailable unless the
required services are present and is never counted as passed from discovery,
mock, memory-only, or skip evidence.
