# Rallar Recipe Console Large-Run Scale And Windowing Implementation Plan

Status: complete; parent Iteration 9 and Ready-State #10 are code-backed through
`f8cef95`. Tasks 0–9, the canonical production scale acceptance, candidate
profiling, four independent review tracks, the complete app and Recipe Console
suites, and the preserved legacy pair are green. The configured-live/Postgres
owner remains skipped, not passed, for the exact unavailable-environment reason
recorded below; no legacy row was hidden or cut over.

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

- [x] Add a deterministic synthetic large distributed-artifact fixture and a
      read-only root `scripts/perf/rallar-recipe-console-scale-bench.ts` harness.
- [x] Assert fixture byte size explicitly: every file <=16 MiB and aggregate
      <=48 MiB under the existing intake contract.
- [x] Record warm-up plus five-run 500/2,000/15,000-row baseline measurements:
      model/search duration, pipeline/file/row parse counters, heap delta, and
      source/index/match counts.
- [x] Persist commit, runtime, fixture bytes, flags, warm-up/run count, per-run
      samples, median, and approximate p95/max under `tmp/perf/results/**`. Invoke
      Node with `--expose-gc --import tsx` whenever heap delta is recorded.
- [x] After the harness-only commit and before algorithm changes, run the fenced
      benchmark command with `--out=tmp/perf/results/iteration-9-base.json`; run the
      identical flags at Task 8 with `iteration-9-candidate.json`.
- [x] Record 5,000 run-pair and 2,000-command Tune baselines, including global
      selection work, projected rows/options, mounted DOM, and heartbeat progress.
- [x] RED-prove safe extrema with a portable 200,000-value correctness case,
      late evidence beyond the retained index is unsearchable, and current Monitor
      and History prefixes are not browseable.
- [x] Capture the existing focused unit/app/browser/build/chunk baseline and
      exact configured-live skip/pass state.

### Task 0 checkpoint — `166b40b`

The deterministic fixture is a schema-valid distributed-run artifact with
12,000 events and 3,000 results, unique first/middle/last needles, actionable
failure/diagnostic evidence, and exact UTF-8 intake size 4,753,103 bytes. A
40,000-row pre-allocation ceiling plus runtime 16 MiB/file and 48 MiB/aggregate
checks keep configurable probes inside the existing browser contract. The
fixture and harness passed an independent re-review with no Critical or
Important finding after correcting the initial invalid manifest, retained-only
search probe, unbounded size input, and incomplete measurement metadata.

The canonical clean-commit command wrote
`tmp/perf/results/iteration-9-base.json` at `166b40b` with Node 26.5.0 on
Darwin arm64, `--expose-gc --import tsx`, one warm-up, five measured samples,
and `dirty: false`. At 15,000 rows the median model duration was 114.584 ms,
the approximate p95/max was 115.246 ms, median retained heap delta was
10,678,856 bytes, the 500-entry index reported 15,003 total entries and 14,503
omissions, and the pipeline parsed 45,000 nonempty JSONL rows across three
passes of each JSONL file. First/middle/last event needles, the first result,
and the middle result were unsearchable; the final result and actionable
controls remained retained. These wall-time and heap values are advisory only;
the exact cardinality, omission, and parse counters are the acceptance truth.

A read-only one-shot Node probe established the remaining UI cardinality
baseline. Five thousand paired runs produced History counts
`available=5000,total=5000,rendered=100,omitted=4900` in 15.350 ms while
touching distributed manifests 5,400 times. The unbounded Tune catalog produced
5,000 options in 69.303 ms and current source selects imply 10,002 option nodes.
A valid 2,000-command `rtc.stream` recipe produced 24,002 unique/editable Tune
knobs in 15.184 ms, all currently mapped into one candidate select. Formal
global/inactive-work counters, browser-mounted counts for these synthetic
collections, and a deterministic heartbeat do not exist yet, so those portions
remain open and are not represented as passed.

Fresh baseline validation is 214/214 focused unit tests; shared TypeScript and
all seven Deno entries; app TypeScript; a 616-module production build; reciprocal
experience-chunk proof; and 78/78 focused Chromium tests spanning Analyze,
Monitor, History, Tune, responsive/accessibility, CSS isolation, and chunks.
The configured live lifecycle was discovered and skipped, not passed, for
exactly: `Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
apps/rallar-black-box-control-server, and apps/rallar-black-box available.`

The remaining RED baseline is also explicit: the current 500-entry artifact
index loses the canonical late needles, Monitor reports an omitted prefix
without traversal, and History renders only its first 100 filtered rows. The
initial 200,000-value public performance case failed with `RangeError: Maximum
call stack size exceeded`; review then exposed the same failure in
200,000-command recipe preflight. Both cases are green through `31a7779` after
one-pass extrema/first-positive reducers, and the two per-agent array-copy
accumulators are now linear. Independent re-review found no Critical or
Important issue.

## Task 1: Add One Parsed Artifact Pipeline And Safe Linear Primitives

- [x] Add an additive parsed distributed-artifact representation under
      `packages/shared-test/rallar-bb-test/**`; reuse it for compatibility,
      snapshots, analysis, monitor/report, and evidence derivation.
- [x] Preserve existing public functions as delegating compatibility surfaces.
- [x] Replace externally sized spread extrema with single-pass reducers.
- [x] Replace quadratic stream-sample equivalence scans with deterministic
      keyed buckets while preserving precedence and collision behavior.
- [x] Reuse one derived Monitor/report where current pipelines recompute it.
- [x] GREEN shared tests for exact old behavior, one source-file pass and at
      most one `JSON.parse` per JSON document/nonempty JSONL record in the new
      pipeline, 200k-value safety, stable output, and linear-work counters.
- [x] Telemetry distinguishes `pipelinePassCount`, JSON document parses, JSONL
      file passes, and nonempty JSONL row parses; no aggregate "parse count" may
      conceal repeated source scans.
- [x] Measure the same harness before/after; accept only with correctness green
      and no material regression in the target large workload.

Task 1 safe primitives are green through `31a7779` and `a357e27`. The public
200,000-value artifact performance case and 200,000-command preflight case are
portable and exact; all artifact-sized extrema/first-positive rest spreads and
the two per-agent array-copy accumulators are bounded. Stream equivalence now
uses deterministic base/fingerprint/identity indexes and lazy minimum-ordinal
heaps while preserving exact identity, identityless, nested, cross-source,
replacement, canonical-key fallback, and winner-index ordering semantics. A
1,500-candidate same-base/same-fingerprint adversarial case records exactly
6,000 index lookups, zero equivalence comparisons, and 6,000 maintenance
inserts instead of the legacy approximately 1,124,250 pair probes. Telemetry is
optional, numeric/index-only, session-local, and secret-free. Independent
re-review found no Critical or Important issue.

The dependency-leaf parsed representation is green through `b76bf08`. It owns
deterministic loose/envelope projection, canonical source text, missing/empty/
parsed/malformed states, JSONL source lines, extensionless Control failure
responses, null-prototype hostile-name-safe maps, and per-file/aggregate pass
and parse telemetry. Differential tests cover escaped envelope keys and
pretty multi-line envelopes under `.jsonl` while ordinary multi-record JSONL
still parses each nonempty row once. All six review-discovered integration and
parity defects were RED/GREEN fixed; final re-review is clean. At that leaf
checkpoint the higher-level workspace/analysis/evidence integration remained
open; the completed proof is recorded immediately below.

Task 1 integration is green through `eb1e745` and `523333f`. Workspace,
compatibility, identity, analysis, snapshots, bundle, Monitor/report,
evidence provenance/indexing, and the Analyze compatibility model now reuse one
parsed representation. Raw public file helpers retain literal loose-file
semantics while workspace alone projects envelopes. SPA derivation failures
remain isolated as `spa-analysis` warnings; v1 synthesized manifests, malformed
optional evidence, runner-summary fallback, dynamic Control responses, and
repeated parsed analysis retain exact behavior. Optional precomputed Monitor
and parsed-control inputs are additive; no existing export or server contract
changed.

The final same-command five-run evidence/app measurement observes exactly one
source enumeration and read per source file, six JSON-document parses, one
pass per JSONL file, one parse per nonempty source row, and zero unclassified
parses at 500, 2,000, and 15,000 rows. Root medians were 5.257, 18.265, and
96.999 ms versus baseline 5.502, 18.686, and 114.584 ms; none crosses the
1.25× advisory threshold. A separate same-machine sample was faster still,
confirming timing noise while the structural counters remained identical.
Independent API/parity and performance re-reviews found no Critical or
Important issue. The ignored canonical Task 8 candidate remains reserved for
the final fully composed implementation rather than this intermediate slice.

The stream-index telemetry follow-up is green through `56d4a43`. Prepared
base keys and fingerprints are reused during positive equivalence and
replacement checks, so the reported fingerprint count now equals the actual
serialization count under replacement-heavy stale-heap invalidation. The
focused 28-test analysis suite and shared TypeScript/Deno checks pass.

## Task 2: Add Deterministic Cursor/Window And Compaction Contracts

- [x] Add opaque artifact/model/query-bound cursor and explicit window types in
      shared-test. Reject stale, foreign, malformed, and tampered cursors.
- [x] Traverse retained evidence in stable source/order semantics with no gaps
      or duplicates; filter changes reset the cursor.
- [x] Keep current search API unchanged and add a full retained-catalog search
      window API with an explicit hard bound and exact upstream omission truth.
- [x] GREEN shared tests for first/middle/last needles, exact totals, all cursor
      boundaries, the 20,000-entry ceiling/retention policy, three distinct
      omission classes, and standalone generic handoff.

Task 2 is green through `4e89a17`. The additive catalog retains at most 20,000
entries with primary-failure/latest-diagnostic anchors and stable newest-row
selection; the legacy 500-entry index/search API remains unchanged in
differential tests. Opaque per-session HMAC cursors bind artifact, model
instance, normalized query, window size, and offset. Cursor integrity and
bindings are checked before catalog matching. One bounded `Uint32Array` query
index serves complete forward/backward traversal, with a default 64-row and
hard 100-row window.

Structural counters prove one 15,003-entry match evaluation across the full
round trip: 468 verified cursors, 468 cache hits, 15,003 match writes, and
29,979 window reads. A tampered cursor performs one verification and zero
catalog work. Catalog derivation hashes fixed canonical identities in bounded
128-row batches, retains at most 20,002 candidate references including the two
anchors, and only sorts/projects 20,000 rows. Bounded raw search evidence is
part of the canonical identity, so true repeats collapse while raw-distinct
bounded-identical collisions remain independently searchable. The high-
collision fixture performs exactly one association and digest per 2,008 source
rows. Producer compaction remains explicitly unavailable and separate from
index/query/render omissions; generic `artifact-index.json` compaction remains
owned by the standalone legacy reader.

Fresh root validation passed 69 focused tests, shared TypeScript and Deno,
app TypeScript, and diff checks. The latest advisory benchmark medians were
5.329/12.683/75.497 ms for 500/2,000/15,000 rows versus the frozen
5.502/18.686/114.584 ms baseline; 15k retained heap was 10,198,392 bytes versus
10,678,856. Independent API/security and performance reviews found and drove
four Important RED/GREEN fixes; final re-review is clean.

## Task 3: Move Analyze Derivation And Search Off The Blocking Main Thread

- [x] Add a focused `src/recipe-console/analyze/**` lifetime worker and typed
      request/response adapter; keep it lazy to Analyze import/load and absent from
      the eager shell.
- [x] Keep raw/parsed files, the full evidence catalog, search haystacks, and
      cursor execution worker-owned. The main thread receives only compact summary,
      analysis/quality/performance projections, the current <=64-row window, and
      the selected evidence projection—not duplicate artifact strings/snapshots.
- [x] Export/reimport bytes on demand through a Blob or transferable buffer;
      never structured-clone accepted 48 MiB strings back and forth per operation.
- [x] Separate in-flight candidate and accepted artifact lifetimes. Abort/
      terminate a candidate on authority loss; keep the accepted worker across
      Analyze→Tune and ordinary view/context changes until Clear, replacement,
      Recipe Console unmount, crash, or explicit disposal.
- [x] Retain one exportable Blob/transferable envelope outside the worker so
      accepted export remains available without a second Control request even if
      the worker fails. Handle `error`, `messageerror`, and unexpected exit with
      last-usable bounded projection truth.
- [x] Reuse existing operation authority: validate Control identity before
      accepting the candidate and patch the URL only after accepted completion.
- [x] Expose an on-demand bounded Tune facade containing manifest, focused/
      compared-run truth, tuning inventory/candidate inputs, and received-message
      deltas without raw event/result arrays.
- [x] Return only bounded clone-safe projections plus numeric telemetry. Errors
      cross a typed secret-free boundary.
- [x] Emit local performance measures for parse/model/search and DOM attributes
      for source/index/match/mounted/render counts.
- [x] Make responsiveness deterministic: worker posts `accepted`; adapter paints
      pending on the next rAF; only then it sends `start`. Assert protocol order
      `accepted → pending-painted/start → complete`. Use a controllable fake to
      prove input/navigation during held search/window replies; real-browser proof
      asserts the actual worker asset/request.
- [x] Give build/search/window requests monotonically generated authority.
      Query A→B and window N→N+1 must suppress late A/N responses, selection, and
      telemetry.
- [x] GREEN Analyze→Tune→Analyze, compare/candidate, export-after-navigation,
      candidate rejection, worker crash/disposal, and stale search/window tests.
      Telemetry is finite, exact, token/payload-free, non-persistent, and clears/
      bounds performance entries so they cannot grow per search.

Task 3 is green through `77b0922`. Analyze now lazy-loads a focused worker only
after artifact import/load, paints accepted pending state before `start`, keeps
candidate and accepted lifetimes separate, and retains only bounded projections,
one export Blob, numeric telemetry, and an on-demand bounded Tune facade on the
main thread. Exact Control identity is SHA-256-bound inside the worker; bounded
opaque display handles are explicitly non-authoritative and never become URL
IDs. Request generations, watchdogs, disposal, crash/message-error handling,
late-response suppression, and last-usable Tune/export behavior are executable.

Control artifact bodies are streamed under declared and observed byte limits.
Non-success bodies use a 64 KiB ceiling while preserving HTTP status for token
broker retries; modern engines accumulate in one resizable backing store and
transfer it to an exact fixed buffer before worker handoff. Local form, URL, and
worker strings share one 4,096-byte UTF-8 contract, so multibyte overflow is
rejected visibly without stale evidence authority. Every Analyze TS/TSX module
is at most 300 lines.

Fresh Task 3 proof passed 280/280 focused unit tests, shared TypeScript and all
seven Deno checks, app TypeScript, a 621-module production build, reciprocal
experience-chunk proof, and 21/21 focused Chromium cases including the emitted
worker asset, accepted→paint→start order, Control safety, multibyte URL bounds,
and retained Tune operation. Independent protocol/security, regression, and
large-scale reviews report no Critical or Important findings. No navigation
row, legacy visibility/mount, public export, control-server endpoint, default,
or cutover status changed.

## Task 4: Add Reusable Accessible Window Controls

- [x] Add bounded UI/model owners under `src/recipe-console/ui/**`; do not grow
      a global registry or stylesheet.
- [x] Render native list/table children for one explicit range with
      Previous/Next, range/total, disabled boundaries, aria-live announcements,
      and deterministic reset on fingerprint change.
- [x] Preserve focus when the active row stays in range; return focus to the
      range control when a row leaves the mounted window.
- [x] Meet 44px touch targets, reduced motion, RTL/bidi-safe exact identifiers,
      short-landscape containment, and keyboard operation.
- [x] GREEN focused model/component tests before composing feature UI.

The behavior-neutral reusable primitive is green through `bbf2385`: a pure
fingerprint-bound range model, thin local-state/focus owner, controlled native
Previous/Next controls, live exact range, local logical-property CSS, 44px
targets, short-landscape containment, and reduced-motion behavior. Eleven
focused model/hook/component/focus tests, app TypeScript, and a 616-module
production build pass. Independent review found and RED/GREEN fixed a
null-related-target stale-focus edge; final re-review is clean. Native Analyze
list composition and long-ID/bidi proof are green with Task 5. Monitor and
History composition remain open in Tasks 6–7 and are not represented as passed
here.

## Task 5: Window Analyze Search Without Losing Late Evidence

- [x] Compose shared full-catalog search windows in Analyze while preserving
      v1 URL filters and existing inspector selection semantics.
- [x] Find exact last-event and last-result needles beyond the former 500-entry
      cap and browse every retained match with at most 64 mounted rows.
- [x] Display producer-compacted, index-omitted, matching, and render-window
      states separately. Analyze says producer compaction is unavailable; never
      synthesize it from the 20,000-entry catalog cap or label omissions searchable.
- [x] Keep result selection, inspector focus, local/control import, export/
      reimport, and legacy Shared Test handoff operational.
- [x] GREEN unit plus real-browser tests for search, cursor reset, focus,
      telemetry, offline/error/partial/future-schema states, and CSS isolation.

Tasks 4–5 are green through `6d90061`. Analyze composes the shared full-catalog
cursor contract into one native `<ol>` with at most 64 mounted rows, exact
one-based range truth, Previous/Next boundaries, fingerprint reset, stale and
request-scoped authority, retry, keyboard operation, and stable inspector
focus recovery. Exact identifiers use the shared bidi-isolated rendering in
both result rows and the inspector. Producer compaction unavailable, index
omission, matching, and browseable render-window omission remain separate.
Initial, pending, unavailable, and completed-zero search states no longer
publish invented `0 matches` or no-match truth.

The Task 5 exit validation passed 129/129 focused Analyze tests and 132/132
structure/History/retention tests, app TypeScript, a 631-module production
build with its emitted Analyze worker, and the reciprocal experience-chunk
assertion. The expanded Analyze Chromium matrix passed 22/22. Its canonical
production case collected 15,003 unique evidence IDs across all 235 cursor
windows without a gap or duplicate, kept every window at 64 rows or fewer,
ended at exact range `Showing 14,977–15,003 of 15,003 retained matches.`, moved
backward from the final window, and found the exact last event and result. The
canonical case took 15.4 seconds inside its 120-second test budget; that wall
time is recorded evidence, not an absolute CI gate. After the final truth-label
re-review fix, the directly affected focused unit slice passed 22/22 and the
directly affected browser slice passed 15/15.

The in-app Browser attempt returned exactly `No browser is available`, and
`agent.browsers.list()` returned `[]`; the recorded browser evidence is the
documented Playwright/System Chromium fallback, not an in-app Browser pass.
This slice used deterministic/simulated fixtures and made no live-service
claim; the existing configured-live skip remains unchanged. Independent
review drove request-timeout/retry, stale/pending/failure truth, stable focus,
exact-identifier, complete-traversal, and pre-search/no-match RED/GREEN fixes;
final re-review reports no open Critical or Important finding.

At this Task 5 checkpoint, Tasks 6–9 were open. Task 6 is now green at the
checkpoint below; parent Iteration 9 remains in progress for Tasks 7–9, final
profiling, and the iteration-wide exit. No legacy surface, primary navigation
row, mount policy, deep link, rollback URL, default, or cutover changed.

## Task 6: Replace Monitor Prefix Caps With Browseable Windows

- [x] Reuse one indexed Monitor/report/verdict derivation per snapshot and avoid
      repeated per-agent/per-recipe scans where proven by counters.
- [x] Add reusable run-by-control/agent/command indexes for the always-on root
      control selection path; unchanged five-second polls must not repeat expensive
      global board/options work.
- [x] Retain Analyze artifacts across views without sorting/filtering all run
      selector options while Analyze is inactive.
- [x] Window events, timeline, composite results, diagnostics, failures,
      participant matrix, and recipe/readiness tables only where collections can
      exceed their existing visible bounds.
- [x] Preserve failure-first order, selected evidence/inspector links,
      current/last-known truth, polling/action authority, and exact omission truth.
- [x] GREEN tests that late events/results/agents are reachable, filters reset
      the correct window, no section mounts beyond its budget, and polling does not
      repeat unchanged expensive derivation. Include exact global-selection and
      inactive-Analyze work counters under 5,000 run pairs.

Task 6 is green through `0b260ec`, `a258a9e`, `bbb2548`, `ef78e75`, and the
composed code milestone `8c630fc`. Monitor/report/verdict share one linear
index per source snapshot, retain only numeric work plus first command phases
for report reuse, and preserve the pre-index 5,000-row Monitor, report, and
verdict hashes.
Resolved/manifest membership precedence, duplicate targets/selections,
delimiter/bidi identities, first-link action semantics, diagnostic ordering,
and exact ±15-second correlation bounds remain differential-tested. Both
2,000×2,000 all-unroled and same-role matrices avoid an agent×recipe relation;
the measured focused cases complete in 6–8 ms with only 2,000 target descriptors
and 2,000 numeric recipe counts. Independent review also forced lazy,
report-local fallback/link counters: a no-failure cross-run report reads zero
of 5,000 links, while one failure performs one exact pass and one lookup.

Control polling now associates invisible, session-local revision tokens from
the exact `/runs` and `/distributed-runs` response documents without changing
public fetch or snapshot shapes. Raw text capture is scoped to those two
snapshot endpoints; generic artifacts and other control responses are not
tagged. The internal shared ordinal topology retains primitives and ordinals,
not source objects, and distinguishes global-first, first ID/control pair,
all-compatible source order, and board last-winner/first-insertion policies.
Its selected-run overlay matched legacy object identity/order across 20,000
randomized projections after review fixed duplicate override and nullish role
fallback traps. Exact cloned 5,000-pair polls reuse the one-entry topology with
zero rebuild/global visits and rebind only current-poll objects.

Inactive Analyze now returns one frozen empty option set before traversing
either 5,000-row collection and sends no search request in Execute, Monitor,
History, or Tune. Artifact, blob/export, Tune facade, worker lifetime, and
off-view context invalidation remain active; entering Analyze emits one latest
search and preserves prior option order/current-object identity. The indexed
Control selection and agent-board consumers now reuse exact-revision topology,
perform O(1) trusted absence checks, project only the active ordinal plus the
selected overlay, and retain duplicate/order/cross-control/synthetic legacy
parity. The 5,000-pair exact-clone case performs no repeated global traversal.

Main Monitor and inspector evidence now use explicit accessible Previous/Next
windows with exact one-based ranges and outside-window truth. Main budgets are
60 failures, 80 agents, 60 recipes, 60 readiness rows, 50 diagnostics, and 40
timeline/events/composites; inspector budgets are 16 command-evidence rows and
40 failure-destination or diagnostic-link rows. Stable source ordinals preserve
duplicates and exact identifiers, disclosures mount no hidden rows while
closed, filter/fingerprint changes reset the correct cursor, and focus returns
to the persistent range control when polling or a threshold change removes its
row. Failure-first order, current/last-known authority, existing actions, URL
state, and inspector correlations remain unchanged.

The settled Task 6 exit passed 226/226 focused Vitest tests across 11 files:
28 query, 24 structure, 10 shared topology, 3 cache, 69 API, 27 Monitor state,
17 board, 26 control selection, 1 provider, 13 main-window, and 8 inspector-
window cases. App TypeScript, the 655-module production build, reciprocal
experience-chunk proof (`RecipeConsoleApp-D4wdYE2J.js` and
`LegacyExperience-DzD-0gim.js`), and `git diff --check` passed; only the
existing greater-than-500-kB advisory remained. Browser proof passed 11/11
combined large/existing Monitor cases and 6/6 responsive/accessibility and CSS-
isolation Monitor cases. The new large fixture alone passed 4/4 and verified
1440×900 desktop, genuine-touch 430×932 portrait, genuine-touch 932×430
landscape, exact traversal without repeated/skipped IDs, URL-stable reverse
navigation, reduced motion, operational truth, contained scrolling, and clean
Direction A composition. The desktop, portrait, and landscape screenshots were
visually inspected and clean.

Two early Playwright attempts overlapped live source edits—first consumer
composition, then a neutral binding-file move—and were unavailable as product
verdicts; both affected sets reran fully green on stable source. A direct
`tsx --test` UI attempt was also unavailable because Node cannot load CSS
modules; authoritative Vitest passed. The in-app Browser returned exactly
`No browser is available`, so Playwright/System Chromium is fallback evidence,
not an in-app Browser pass. The configured-live owner remains skipped, not
passed, for exactly: `Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed
apps/api-v1, apps/rallar-black-box-control-server, and
apps/rallar-black-box available.` Indexed-consumer, browser, and final Task 6
exit re-reviews are clean after three Important exit-review findings were
resolved with focused proof; no Critical finding remained.

Task 6 does not satisfy Ready-State #10 by itself. Parent Iteration 9 remains
open for Tasks 7–9, including History/retention/Execute/Tune pressure lists,
the canonical scale owner, remaining Tune heartbeat measurement, and final
profiling. No primary/default navigation, legacy visibility, mount policy,
deep link, rollback URL, control contract, or cutover changed, and no legacy
row was hidden.

## Task 7: Window History, Retention Consequences, And Proven Pressure Lists

- [x] Replace History's first-100 dead end with a 5,000-row deterministic
      window while preserving full-set counts, quarantine, Baseline/Candidate,
      saved filters, copied URLs, and cleanup reconciliation.
- [x] Slice the History window before per-row label projection, Tune catalog/
      quarantine work, connected-agent scans, and action projection. Assert the
      expensive projected-row counter never exceeds the active window budget.
- [x] Bound retention candidate/linked/global-ID DOM with explicit windows;
      exact server consequences and confirmation fingerprints remain unchanged.
- [x] Profile and then window the proven 2,000-command Tune maximum, unbounded
      run selectors, and target collections to <=100 mounted options/rows while
      preserving catalog/selection semantics and event-loop heartbeat progress.
- [x] Replace pressure-path native selects with an accessible searchable
      combobox/listbox window; native `<select>` children are not silently sliced.
      Build only cheap run identity indexes globally and derive Tune performance
      for the focused/compared pair, never every 5,000-run catalog entry.
- [x] Present existing generic `artifact-index.json` compaction/truncation in
      `src/legacy/runner/shared-test/**` only; keep the generic handoff, identity,
      parsing, rollback route, and mount policy unchanged.
- [x] GREEN `recipe-console-shared-test-compaction.test.ts` and exact browser
      `recipe-console-legacy-shared-test-compaction.spec.ts` — `shows bounded
  generic artifact compaction without changing the Shared Test fallback`.
- [x] GREEN component/browser tests for last-window reachability, long exact IDs,
      keyboard/touch/focus, dialog safety, and no destructive-request regression.

## Task 8: Canonical Production Scale Acceptance And Profiling

- [x] GREEN exact Ready-State #10 title against production port 4176.
- [x] Assert 15,000 source rows, exact late needles, <=64 mounted Analyze rows,
      5,000 History pairs, <=80 mounted History rows, finite telemetry, one parsed
      representation with exact file/record counters, responsive search/window
      actions, and no document overflow.
- [x] Assert <=100 mounted options/rows for 2,000-command Tune, run selectors,
      targets, Monitor pressure lists, and retention consequences; assert bounded
      global-selection/Tune-derivation and History-projection work counters plus
      heartbeat progress. Traverse first/middle/last evidence inside the exact test.
- [x] Exercise desktop 1440x900, tablet 900x900, portrait 430x932, landscape
      932x430, keyboard, touch, reduced motion, operational states, both CSS load
      orders, lazy chunks, and unmount cleanup.
- [x] Record five-run candidate measurements and compare model/search median,
      approximate p95-max, and heap/count signals to Task 0 without turning
      machine-dependent milliseconds into CI gates. Browser responsiveness is the
      deterministic accepted→paint→start/held-RPC protocol gate, not a synthetic
      long-task before/after claim.
- [x] Record Canvas as deferred with measured reason unless the profile shows
      a real dense-DOM bottleneck requiring a separate accessible design.

## Task 9: Reviews, Fresh Exit, Documentation, And Milestone Commits

- [x] Dispatch independent shared-algorithm/performance, worker/state,
      UI/accessibility/browser, and strangler/cutover reviews; RED/GREEN every
      Critical or Important finding.
- [x] Run focused shared/app tests, complete app suite, shared/app TypeScript and
      Deno checks, build/chunk assertion, complete Recipe Console config, exact
      legacy navigation/ticket pair, and control-server tests if touched.
- [x] Try the in-app Browser and record exact availability; report configured
      live/Postgres tests as skipped with the exact reason when unavailable.
- [x] Update this plan, parent ledger/risks, product spec, migration register,
      and fidelity ledger with commits, counts, measurements, proof, skips,
      unchanged rollback/cutover status, and remaining Iterations 10–12 risks.
- [x] Make cohesive local green milestone commits. Do not push or open a PR.

### Tasks 7–8 and canonical scale exit — `58070bf` through `796fa59`

History now traverses all 5,000 filtered run pairs in deterministic 80-row
windows and performs expensive row projection only for the active window.
Retention candidate, distributed-run, fleet-report, and global consequence
lists use exact 50-row windows without changing preview fingerprints or
destructive authority. Execute bounds 250 control runs and 240 target rows;
Tune indexes 5,000 paired runs with cheap identities, derives performance for
only the two requested comparison runs, and indexes 24,002 editable knobs in
one pass. Searchable disclosure/listbox controls mount at most 100 options,
retain keyboard/touch/focus behavior, preserve unavailable and invalid
selection truth, and unmount their popup DOM when closed. Generic compaction
truth remains solely in the preserved legacy Shared Test importer.

The exact production-port owner, `keeps synthetic large event and result lists
bounded responsive and searchable`, passes with 12,000 events, 3,000 results,
5,000 History pairs, 5,000 Tune pairs, 24,002 knobs, 250 Execute runs, 240
targets, every Monitor pressure collection, retention consequences, and first/
middle/last traversal. Analyze mounts at most 64 rows; History at most 80; every
other pressure list at most 100. The Analyze worker reports one pipeline pass,
one source collection pass, eight file visits, six JSON document parses, two
JSONL file passes, and exactly 15,000 nonempty JSONL row parses. The held-refresh
Tune protocol proves an event-loop heartbeat before accepted work, after paint,
and while the distributed snapshot RPC is held; a cloned poll reuses the
catalog and knob index without losing search, draft, or cursor state.

The clean candidate harness at `796fa59` used the same Node 26.5.0 Darwin arm64
runtime, `--expose-gc --import tsx`, one warm-up, five measured runs, and
500/2,000/15,000 sizes as baseline `166b40b`. At 15,000 rows, model median
improved from 114.584 ms to 73.337 ms (0.640x), approximate p95/max from
115.246 ms to 79.725 ms (0.692x), search median from 0.870 ms to 0.860 ms
(0.988x), and retained model heap median from 10,678,856 to 10,028,264 bytes
(0.939x). No measured size crossed the 1.25x investigation threshold. These
timings and heap values remain advisory; exact counters and browser behavior
are the gates. The historical 5,000-pair/2,000-command UI baseline recorded
5,400 manifest touches, 10,002 unbounded run-option nodes, and 24,002 knob
options; its browser heartbeat probe completed decode-to-DOM in a 198.2 ms
median while advancing zero timer/rAF beats. The accepted implementation keeps
the heartbeat progressing and bounded DOM mounted. Canvas remains deferred:
profiling identified pressure in variable-height rows/options and repeated
derivation, not a dense timing plot; worker derivation, indexes, and accessible
windows remove the measured bottlenecks without Canvas accessibility cost.

### Task 9 final exit — `66a16fd`, `12999dd`, `f8cef95`

The final selector migration replaced stale native-select browser assertions,
restored Direction A's Execute inline selector geometry, and refreshed only the
reviewed Tune and Monitor baselines for the required searchable control and
later exact-ID/action contracts. Independent browser review found a live-shrink
focus defect after a source row disappeared. RED/GREEN repair now restores in
order to the connected source trigger, exact owning range anchor, visible
selection dock, or named work surface; hidden/unfocusable candidates fall
through only after focus verification. The nine-case Monitor windowing suite
covers exact matrix and multi-window anchors, hidden tablet dock, visible
portrait dock, keyboard, touch, bidi evidence, reduced motion, operational
states, URL stability, and zero mutation.

Fresh final-head evidence is 131/131 app test files and 1,385/1,385 tests;
shared and app TypeScript; all seven shared Deno entries; a 699-module
production build; reciprocal Recipe Console/Legacy Experience chunk proof;
169/170 Recipe Console Chromium cases with the sole configured-live owner
skipped; and 28/28 preserved legacy navigation/agent-ticket cases. The exact
Ready-State #10 production case passed in 27.7 seconds inside the complete
48.8-second browser run. Four independent shared-algorithm/performance,
worker/state, UI/accessibility/browser, and strangler/cutover reviews are clean
after every Critical/Important finding received focused RED/GREEN proof. The
in-app Browser remained unavailable exactly as `No browser is available`
(`agent.browsers.list() === []`), so repository Playwright/System Chromium is
the recorded fallback, not an in-app Browser pass.

Configured live/Postgres is skipped, not passed, for exactly: `Set
RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
apps/rallar-black-box-control-server, and apps/rallar-black-box available.` No
control-server source was touched. No public export or existing endpoint was
removed or changed. The default and primary navigation, every legacy row,
mount policy, deep link, alias, rollback URL, and cutover status are unchanged;
Iterations 10–12 remain responsible for Fleet, Advanced diagnostics, and the
final default flip.

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
