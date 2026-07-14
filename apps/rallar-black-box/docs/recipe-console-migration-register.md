# Recipe Console Migration Register

Status: canonical migration register; Iteration 9 and Ready-State #10 are
code-backed through `f8cef95`, Iteration 10 is code-backed through `0088be0`
and `3ab86a9`, and all legacy workflow rows remain visible, deep-linkable, and
uncut
Evidence/status date: 2026-07-14

This register is the source of truth for surface-by-surface strangler status, compatibility aliases, mount policy, state ownership, cutover proof, rollback, and audit evidence. Product intent and Ready-State traceability live in the [Recipe Console product spec](./recipe-console-product-spec.md). Iteration status, binding decisions, baseline validation, and risks live in the [SPA reimplementation plan](../../../playground/rallar-black-box-spa-reimplementation-plan.md).

No row below is newly cut over or newly hidden. `Consolidated` describes navigation that already exists in `app-tabs.ts`; it is not Recipe Console parity. All rollback URLs are SPA-root-relative and intentionally use the current compatibility codec.

## Iteration 10 Fleet implementation start — `7d25ab9`

Repository evidence supersedes the register's stale filename-level extraction
target. The behavior-preserving Fleet extraction already landed at `9e5b4b5`
under `src/legacy/runner/fleet/**`: its feature root, controller, helpers, and
controlled views are outside `App.tsx`, mount only for the active legacy Fleet
tab, and are protected by exact structure/parity gates. Adding a redundant
`LegacyFleetRoute.tsx` wrapper would weaken that stronger proof, so the existing
feature root remains the legacy owner and operational rollback.

The reviewed Iteration 10 child plan adds tolerant and deterministic Fleet
report/geographic analysis under `packages/shared-test/rallar-bb-test/**`, then
a separate lazy/unmounted `src/recipe-console/fleet/**` route using the existing
root control query and indexed selection. It binds bounded browseable evidence,
explicit location/route provenance, `fleetRegion`/`fleetMapLayers`, exact
agent/run/History/Analyze handoffs, Direction A CSS isolation, and the full
responsive/input/operational-state browser matrix. It adds no second poll,
credential owner, endpoint, required artifact file, default change, hide, or
cutover.

The clean baseline passes 74/74 focused unit tests and 3/3 legacy Fleet browser
cases after the sandbox-only port-bind attempt was rerun with local-server
permission. The new canonical Recipe Console Fleet acceptance remains open;
these baseline results do not change this row's migration status.

### Shared Fleet evidence and boundary milestone — `0d046ca`

Tasks 1–4 add tolerant schema-v1 Fleet report validation, deterministic
report/geographic analysis, legacy parity adapters, collision-safe public
identities, bounded bundle transfer, a lazy authorized one-bundle capability,
and exact pending-safe Fleet selection and handoff contracts. The stable gate
passes 267/267 focused tests, shared/app TypeScript, direct Deno checks for the
new shared modules, and two clean independent exit reviews.

At this milestone Direction A was approved, and before the visual workspace
could land, the shared
analysis must expose one indexed collection with complete bounded
first/middle/final traversal; the compatibility projection currently returns
only its first window. That correction, the lazy Fleet UI/map/artifact surface,
responsive/CSS/chunk browser proof, and the Iteration 10 exit remain open.
This milestone changes no default, primary navigation, public export, existing
control-server contract, legacy alias, mount policy, visibility, or cutover.

### Qualified Fleet capability exit — `0088be0`, `3ab86a9`

`0088be0` completes the mandatory shared indexed traversal and adds the lazy,
active-only Recipe Console Fleet workspace without importing the legacy panel
or adding a second query, poll, credential owner, endpoint, registry, or broad
stylesheet. Bounded live-board, heatmap, region, repeated-failure, timing, map,
selected-report, and artifact evidence remain completely browseable. Location
and route provenance, separate live/historical authority, opaque artifact
identities, and exact agent/run/History/Analyze handoffs are explicit.

`3ab86a9` proves the canonical Fleet flow, Direction A responsive matrix,
keyboard/touch/reduced-motion behavior, all operational states, URL and browser
history restoration, CSS isolation, inactive cleanup, reciprocal chunk
separation, and unchanged `fleet`, `fleet-report`, and `fleet-reports` legacy
aliases. Fresh qualification passed 279/279 focused tests, shared/app TypeScript
and shared Deno gates, the 758-module build, reciprocal chunk assertion,
1,472/1,472 complete app tests across 139 files, Fleet 7/7, visual no-update
3/3, broader Recipe Console 65/65, the complete Recipe Console configuration
with 179 passed and one exact configured-live skip, legacy Fleet/navigation
33/33, and existing-owner regressions 28/28. Independent shared, geography,
React/state/accessibility, browser, and strangler reviews are clean.

The in-app Browser was unavailable exactly as `Browser runtime unavailable
after setup failure: Cannot redefine property: process`; terminal Playwright
is fallback evidence. Configured live/Postgres remains skipped, not passed,
for exactly: `Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed
apps/api-v1, apps/rallar-black-box-control-server, and apps/rallar-black-box
available.` This is a capability proof, not a legacy row cutover. The legacy
Fleet row, active-only mount, rebuild/export actions, aliases, deep links, and
rollback URL remain operational and visible; no default, public export, or
existing control-server contract changed. Iterations 11–12 retain Advanced/
context, safe lazy legacy ownership, default-flip, and final accessibility risk.

## Iteration 9 qualified scale milestone — `58070bf` through `f8cef95`

Tasks 7–9 complete the scale capability without changing a migration row.
History traverses 5,000 pairs in 80-row windows; retention consequences use
50-row windows; Execute bounds 250 run choices and 240 targets; Tune indexes
5,000 paired runs and 24,002 knobs while deriving only the explicit pair.
Analyze's one shared worker pipeline mounts at most 64 rows, and every Monitor
main/inspector pressure collection is browseable. Searchable popups and closed
disclosures are unmounted, not CSS-hidden.

The exact production Ready-State #10 owner passes with 15,000 artifact rows,
first/middle/last search and traversal, exact parse/work counters, bounded DOM,
heartbeat progress, desktop/tablet/touch portrait/touch landscape, keyboard,
reduced motion, operational states, CSS isolation, chunk boundaries, and
cleanup. Fresh exit passed 1,385/1,385 app tests, shared/app TypeScript, seven
shared Deno entries, a 699-module build and reciprocal chunk proof, 169
available Recipe Console browser cases, and 28/28 preserved legacy cases. Four
independent review tracks are clean after focused selector/focus repairs.

The in-app Browser remained unavailable exactly as `No browser is available`;
Playwright/System Chromium is fallback evidence. Configured live/Postgres is
skipped, not passed, for exactly: `Set RALLAR_BLACK_BOX_FULL_STACK=1 with
Postgres-backed apps/api-v1, apps/rallar-black-box-control-server, and
apps/rallar-black-box available.` Ready-State #3 therefore remains open.

This milestone changes no default or primary navigation, legacy visibility or
mount, compatibility alias, deep link, rollback URL, public export, existing
control-server contract, or cutover. `runner.runs`, `runner.distributed-monitor`,
`runner.artifact-analysis`, `runner.compare`, `legacy.distributed-recipes`, and
`legacy.shared-test-import` all retain their prior visibility, mount policy,
and rollback. Iterations 10–12 own Fleet, Advanced diagnostics, and the final
default flip.

## Iteration 9 Monitor scale milestone — `8c630fc`

Task 6 composes exact-revision Control selection/agent-board indexes and
accessible Monitor windows without changing public snapshots, server
contracts, v1 URL fields, or existing operations. Unchanged 5,000-pair polls
reuse topology without global rebuild work; active selection and selected
overlays preserve legacy identity, duplicate, ordering, cross-control, and
synthetic behavior. Inactive Analyze still performs zero run-option traversal
and sends no search request.

Main failures, agents, recipes, readiness, diagnostics, timeline, events, and
composites plus inspector command evidence, failure destinations, and
diagnostic links expose exact browseable ranges. Stable source IDs traverse
without gaps or duplicates, closed disclosures mount no retained rows, window
fingerprints reset correctly, and polling/threshold changes recover focus.
Failure-first order, current/last-known truth, action authority, correlations,
and exact bidi-safe identifiers remain unchanged.

The settled gate passed 226/226 focused tests across 11 files, app TypeScript,
a 655-module build, reciprocal Recipe Console/Legacy Experience chunk proof,
and `git diff --check`; only the existing greater-than-500-kB advisory remains.
Stable-source Chromium proof passed 11/11 combined large/existing Monitor cases
and 6/6 responsive/accessibility/CSS-isolation cases. The large fixture's 4/4
cases cover 1440×900 desktop, genuine-touch 430×932 portrait, genuine-touch
932×430 landscape, keyboard/focus, reduced motion, operational states, exact
forward/back traversal, URL stability, bounded mounts, and Direction A
containment. Indexed-consumer, browser, and final exit re-reviews are clean
after three Important exit-review findings received RED/GREEN fixes.

Two early browser attempts overlapped live source edits and were unavailable
as product verdicts; both affected sets reran fully green on stable source. A
direct `tsx --test` UI attempt was unavailable because Node cannot load CSS
modules; authoritative Vitest passed. The in-app Browser returned exactly
`No browser is available`; Playwright/System Chromium is fallback evidence,
not an in-app Browser pass. The configured-live owner remains skipped, not
passed, for exactly: `Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed
apps/api-v1, apps/rallar-black-box-control-server, and
apps/rallar-black-box available.`

This is capability evidence, not a row cutover. Ready-State #10 and parent
Iteration 9 remain open for Tasks 7–9, canonical scale acceptance, remaining
heartbeat proof, and final profiling. No primary/default navigation, legacy
visibility or mount, route, deep link, rollback, control/public contract, or
cutover changed, and no legacy row was hidden.

## Iteration 9 Analyze window milestone — `6d90061`

Tasks 4–5 compose the shared retained-catalog cursor into one native Analyze
evidence list with exact Previous/Next range truth, at most 64 mounted rows,
fingerprint/request authority, retry, keyboard operation, stable focus
recovery, and bidi-isolated exact identifiers. Local and Control import,
selection/inspector, export/reimport, URL filters, and the explicit legacy Runs
and Shared Test handoffs remain operational. Producer compaction unavailable,
index omission, matching, and browseable render-window omission stay distinct;
pre-search, pending, unavailable, and completed-zero truth no longer invents a
count or no-match result.

The Task 5 exit passed 129/129 focused Analyze tests, 132/132
structure/History/retention tests, app TypeScript, a 631-module production
build with the emitted Analyze worker, the reciprocal experience-chunk
assertion, and 22/22 expanded Analyze Chromium cases. The canonical production
case traversed all 235 windows, collected 15,003 unique evidence IDs without a
gap or duplicate, kept every window at 64 rows or fewer, reached exact final
range `Showing 14,977–15,003 of 15,003 retained matches.`, traversed backward,
and found the exact last event/result needles in 15.4 seconds. After the final
truth-label review fix, directly affected unit and browser slices passed 22/22
and 15/15. Independent re-review closed every Critical and Important finding.

The in-app Browser returned exactly `No browser is available`, and
`agent.browsers.list()` returned `[]`; Playwright/System Chromium is fallback
evidence, not an in-app Browser pass. The slice used deterministic/simulated
fixtures and makes no live-service claim. At this milestone Tasks 6–9 were
open; Task 6 is now green in the newer milestone above, while Tasks 7–9, final
profiling, and the parent Iteration 9 exit remain open. This milestone changes
no migration row's visibility, mount policy, deep links, rollback, default, or
cutover status.

## Iteration 9 workerized Analyze milestone — `77b0922`

Analyze artifact decoding, parsed-model/evidence derivation, full retained
catalog search, cursor traversal, selection, and bounded Tune projection now
live behind a lazy feature-local worker. Candidate/accepted authority, exact
Control identity validation, fixed-buffer transfer, retained export, stale RPC
suppression, crash fallback, secret-free telemetry, UTF-8 URL boundaries, and
production worker loading are independently reviewed and green. The main
thread receives only bounded projections and at most 64 current evidence rows.

This milestone changes no migration row. `runner.runs`,
`runner.distributed-monitor`, `runner.artifact-analysis`,
`legacy.distributed-recipes`, and `legacy.shared-test-import` remain visible,
deep-linkable, and governed by their existing mount and rollback policies.
The worker milestone alone inferred no parity or cutover. Tasks 4–6 are now
recorded in the newer milestones above; remaining pressure lists, final
profiling, and Tasks 7–9 stay open inside Iteration 9.

## Iteration 8 qualified History and retention exit — `fd9055e`, `f762749`

Canonical copied-URL restoration and guarded retention acceptance now pass.
The combined workflow finds a past failure with all eight committed filters,
selects Baseline/Candidate through the existing Tune comparison, saves/applies
a bounded preset, previews exact cleanup consequences, explicitly confirms,
refreshes authoritative root truth, reconciles only actually deleted
selections, copies the retained URL, and survives reset/back/forward. Cancel,
authorization, conflict, token absence, request count/body, exact deleted-ID,
keyboard, reduced-motion, coarse-target, four-viewport, CSS-isolation, and
lazy/unmounted boundaries are executable proof.

Fresh exit passed 330/330 focused tests, 1,066/1,066 app tests, shared/app
typechecks, seven shared Deno entries, a 616-module build and chunk assertion,
control-server check plus 79/79 tests, 147 Recipe Console browser cases with
one configured-live skip, and 28/28 legacy navigation/ticket cases. The in-app
Browser also confirmed contained desktop Execute and portrait/landscape Tune
offline states with no warning/error logs. Final state/UI/traceability/visual
reviews are clean.

This is capability proof, not a navigation cutover. `runner.runs`,
`runner.compare`, `legacy.distributed-recipes`, and `legacy.run-manager` remain
visible, deep-linkable, and governed by their unchanged mount policies and
rollback URLs. The configured live/Postgres lifecycle remains skipped, not
passed, for exactly: `Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed
apps/api-v1, apps/rallar-black-box-control-server, and apps/rallar-black-box
available.` No default, public export, existing control contract, or legacy
route changed.

## Iteration 8 guarded History retention UI — `7256379`

Task 7 composes one preview-first retention owner under the bounded History
workspace. The client remains dynamically loaded on Preview; its raw plan token
stays private in memory while the UI displays exact token-free control,
distributed, and fleet consequences, current/projected/cap counts, connected-
agent and issued-token counts, linked distributed states, and unchanged socket/
artifact behavior. Exact IDs preserve whitespace and use explicit LTR bidi
isolation without changing server truth.

The alertdialog starts on Keep history, traps focus, supports keyboard confirm,
Escape and outside cancel, prevents double submit, restores Preview focus, and
keeps conflict evidence visible but nonconfirmable. Endpoint, API-base,
credential-origin, connection-generation, authorization, credential-trust,
StrictMode, stale response, and post-confirm refresh changes abort/invalidate
before a stale confirm or URL replacement. Successful cleanup refreshes the
serialized root query before clearing only selections associated with actual
deletions. Retention owners cannot persist or log preview/token/authorization
material.

Fresh proof is 121/121 focused tests, app TypeScript, a 616-module build,
reciprocal chunk proof, and clean independent race/state, UI/accessibility, and
traceability reviews. Task 8 browser acceptance remains open; this is not a row
cutover. `runner.runs`, `runner.compare`, `legacy.distributed-recipes`, and
`legacy.run-manager` retain their existing visibility, mounts, deep links, and
rollback routes.

## Iteration 8 bounded History workspace — `055c96f`

Task 6 composes exactly one focused History workspace after current Tune
evidence inside the existing lazy Tune closure. The root workspace passes only
the root query, URL navigation, and copy-link callback; it owns no History
feature state. History renders exact source/freshness truth, committed filter
summary, semantic Apply/Reset, bounded local presets, exact counts, full IDs,
safe Baseline/Candidate handoff, empty/partial/stale/offline/error states, and a
generic preserved legacy Runs link. It never fetches an artifact, auto-selects a
past run, executes a recipe, derives a second comparison, or mutates a manifest.

The flat Signal Ledger controls are keyboard-visible and at least 44px. Filters
collapse 4→2→1 columns, the native table owns horizontal overflow, and Tune owns
contained vertical scrolling in short landscape. Exact-ID action labels close
screen-reader ambiguity, and shared guarded UTC formatting preserves safe
epochs outside JavaScript's Date display range without a crash.

Fresh proof is 103/103 History/Tune/build-boundary tests, 63/63 broader
structure tests, app TypeScript, and final independent review with no Critical
or Important issue. Browser responsive/keyboard/CSS-isolation acceptance and
retention confirmation remain open. No legacy row, visibility, mount policy,
deep link, rollback, default, or control-server contract changes.

## Iteration 8 bounded History model — `13070af`, `caa3980`

Task 5 retains root/fallback/unavailable provenance through the serialized root
query and builds a pure bounded server-history model from that one authority.
Shared filtering remains the sole order/filter truth; shared-test also owns the
malformed-safe group, recipe, profile, and actual-failure labels. History
reports exact counts while projecting at most 100 rows, uses generated ordinal
keys, quarantines unsafe/duplicate/invalid identities, and disables selection
for missing or ambiguous control pairs. Exact retention consequences remain
visible and are never sanitized through URL policy.

Baseline and Candidate reuse Tune's identity-safe patches. Pre-cleanup
association capture and cleanup reconciliation preserve History filters,
timing, harmless unknown state, and newer valid selections while clearing only
deleted focus/dependent/comparison fields. The combined filtered Candidate,
cleanup, copied-link, and back/forward sequence is green; async
refresh-before-replace remains a Task 7 UI-hook responsibility.

Fresh proof is 176/176 related tests, complete shared TypeScript and seven Deno
entries, app TypeScript, and final review with no Critical or Important issue.
The review-driven scalability fix limits identity/manifest work to the visible
100 and skips Tune performance derivation while retaining exact full-set counts
and linear duplicate/pair detection. No History UI is composed yet and no row,
visibility, mount, deep link, rollback, default, or server contract changes.

## Iteration 8 bounded History presets — `1e19dfb`

Task 4 adds one versioned, exact-whitelist History-filter store behind an
injected adapter. It keeps at most 12 normalized presets and persists only the
eight committed History URL filters with bounded names and values. Run and
comparison selections, control URL/token state, credentials, artifacts,
transient drafts, and active-preset state cannot enter the envelope. Future
versions are preserved, malformed siblings are isolated, storage failures are
nonfatal, and browser `localStorage` access belongs only to the focused hook.

Fresh proof is 22/22 focused tests and app TypeScript. StrictMode replay and
storage-port replacement regressions were first reproduced, then fixed;
independent re-review reports no remaining Critical or Important issue. Loaded
presets do not override explicit URL state without an operator Apply action.
This foundation composes no History UI and changes no legacy row, visibility,
mount policy, deep link, rollback, default, or control-server contract.

## Iteration 8 shareable History filters — `48b2fd0`

Task 3 adds semantic failure-category filtering over actual run/rollup evidence,
malformed-manifest-safe group/recipe/profile/user filtering, and four additive
v1 URL fields: `historyGroup`, `historyRecipeId`, `historyProfile`, and
`failureCategory`. Operational `recipeId`, comparison, timing, provider, and
harmless unknown state remain independent and copy/popstate compatible. Legacy
raw `failureType`, query, substring, inclusive date, and stable order behavior
is unchanged.

Fresh proof is 78/78 focused tests, shared TypeScript and seven Deno entries,
app TypeScript, and independent review with no Critical or Important
implementation defect. The combined cleanup/back-forward sequence is deferred
to Task 5, and URL-over-preset precedence to Task 4; no parity or cutover claim
uses those pending criteria. All legacy rows remain visible and rollbackable.

## Iteration 8 lazy authorized retention client — `7197beb`

Task 2 adds a dynamic-only, preview-first client without exposing credentials to
feature code. The root transport owns authorization injection and one shared
preview/confirm challenge; the provider exposes a redacted context plus opaque
generation/signal and closes replaced contexts in layout lifecycle with
StrictMode-safe cleanup. Immutable previews are branded to the connection that
produced them, confirmation accepts only that exact current preview, and
concurrent/stale/abort-resistant work cannot become current UI truth.

The legacy manager error import remains identity-compatible. Low-level preview,
confirm, and bare compatibility requests are bodyless and exact; validators
whitelist every success field, verify all candidate/global relationships, and
apply shared cumulative collection/node/depth/string/UTF-8 budgets with linear
reconciliation. Fresh proof is 59/59 retention-client tests, 70/70 existing
manager/control-API tests, 23/23 structure/build-boundary tests, app TypeScript,
a 590-module build, and dynamic-chunk sentinels absent from main, eager Recipe
Console, and inactive Tune closures. Independent review reports no Critical or
Important issue.

This client is capability only. No History UI is composed yet and no migration
row is cut over or hidden; all legacy visibility, mounts, deep links, and
rollback responsibilities remain unchanged.

## Iteration 8 retention server foundation — `07564df`

Task 1 adds only backward-compatible shared/control-server capability. A pure
bounded shared-test plan describes exact control, linked distributed-run, and
linked fleet-report consequences. The authorized server route keeps bare
`POST /retention/cleanup` destructive with its exact three-field shape, adds
non-destructive `?dryRun=true`, and accepts `?planToken=...` only while a short-
lived process/consequence-bound HMAC still matches a fresh synchronous plan.
Invalid preview/confirm queries return `400`, stale/expired/process drift
returns uniform `409`, and bounded preview overflow returns `413`; authorization
always runs before these checks and a plan token is never authorization.

Preview and manual cleanup read no request body, close no socket, and delete no
stored artifact file. Automatic persistence pruning retains its existing
registered-socket/artifact cleanup. Bare/automatic pruning also remains
unbounded by preview limits, preserving behavior beyond 1,000 candidates.
OpenAPI, current-state, and command-execution documentation distinguish all
three modes without implying that preview deletes.

Fresh evidence is 31/31 focused shared tests, complete shared TypeScript and
seven-entry Deno checks, app TypeScript, server check, and 79/79 real-loopback
server tests. Independent reviews closed legacy-bound leakage, noncanonical
signature aliases, and overlapping OpenAPI success schemas, then reported no
remaining Critical or Important issue.

This server foundation is not History/retention UI parity or cutover proof.
`runner.runs`, `runner.compare`, `legacy.distributed-recipes`, and
`legacy.run-manager` retain their visibility, mounts, deep links, and rollback
responsibilities. Task 2's client is now green in `7197beb`; Tasks 3–9 History,
saved-filter, confirmation UI, URL, browser, and exit proofs remain open.

## Iteration 7 timing/tuning implementation start — 2026-07-12

Repository truth confirms that the current Tune view is still the seeded
`high-latency-rtc` preview and consumes neither retained artifact nor root
control evidence. The tests-first
[implementation plan](../../../docs/superpowers/plans/2026-07-12-rallar-recipe-console-tuning-lab-implementation-plan.md)
binds the replacement to additive shared-test ownership for performance,
exact recipe-knob inventory, clone-only validated candidate patches, tuning
hints, and the existing public `compareDistributedRuns(...)` behavior. Recipe
Console will compose those deterministic results from the one retained Analyze
artifact and one root control query without a second poller or mutation API.

This start checkpoint changed no row status, primary visibility, mount policy,
default, alias, deep link, public export, server contract, or rollback route.
Its clean baseline was 118/118 focused tests plus shared/app TypeScript checks
at `20e1df5`; the completed proof follows.

## Iteration 7 timing/tuning exit — `cc17169`, `382df72`

Shared-test now owns the additive deterministic tuning surface: artifact/control
snapshot performance, recursive exact knob inventory, clone-only validated
candidate JSON Patch/diff, readiness-first evidence-backed hints, and selected
performance comparison. Recipe Console composes those results in a separate
lazy Tune entry from the one retained Analyze artifact and the root control
query. The inactive Tune UI is unmounted; there is no Tune poller, second
artifact store, execution import, silent mutation, or legacy component import.

The exact Ready-State #7 timing acceptance, bounded #8 structural comparison,
and no-mutation candidate acceptance pass. The browser proof covers explicit
URL-restored comparison, real RTC disposition/cadence/drift/drops/
backpressure, command and send-duration percentiles, source provenance,
fourteen editable knobs plus blocked/shadowed truth, stale/mismatch/partial/
reference-only/unsupported states, selected-run legacy handoff, every contract
viewport, keyboard/focus, 44px targets, reduced motion, announcements, zero
document overflow, and both CSS load orders.

Fresh exit evidence is 247/247 focused Vitest tests; a qualified-green complete
883-test app suite across 93 files after the restricted sandbox's two denied
IPC/loopback cases passed 9/9 with required permission; complete shared-test
TypeScript and seven-entry Deno checks; app TypeScript; a 580-module build;
reciprocal experience chunks; 137 available Recipe Console Chromium tests with
one configured-live skip; 28/28 preserved legacy navigation/ticket tests; and
57/57 control-server tests. Independent shared, app/state, browser/
accessibility, and cutover re-reviews have no open Critical or Important issue.

The in-app Browser was unavailable exactly as `No browser is available`;
Playwright/System Chromium is fallback evidence. Configured live/Postgres proof
remains skipped, not passed, because: `Set RALLAR_BLACK_BOX_FULL_STACK=1 with
Postgres-backed apps/api-v1, apps/rallar-black-box-control-server, and
apps/rallar-black-box available.`

Ready-State #7 and the bounded comparison evidence for #8 are code-backed.
Ready-State #9, server history, saved filters, retention, authoring, and the
complete workflow cut remain open. Therefore `runner.runs`, `runner.compare`,
`legacy.distributed-recipes`, and `legacy.run-manager` remain visible,
deep-linkable, and uncut. Exact rollback is
`/?workspace=black-box-runner&tab=runs` for `runner.runs`/`runner.compare`,
`/?workspace=black-box-runner&tab=distributed-recipes` for
`legacy.distributed-recipes`, and
`/?workspace=black-box-runner&tab=run-manager` for `legacy.run-manager`.

## Iteration 6 artifact analysis exit — `f96b5b4`, `abe257e`, `9b07330`, `47c332d`

`runner.artifact-analysis` is now code-backed for the bounded distributed-run
artifact workflow. Shared-test owns additive envelope/profile/version
normalization, authoritative schema-v2 inference, file inventory and support
classification, deterministic evidence indexing/search, causal presentation,
and issue Markdown. Recipe Console owns bounded browser intake, memory-only
operation authority, existing credential-aware Control Load, in-memory Export,
failure-first presentation, URL-backed filters, and the contextual inspector.
It does not duplicate analyzer truth or change the control-server payload.

The canonical offline acceptance
`imports a partial bundle offline and focuses the first actionable failure`
passes with zero artifact endpoint reads. The broader Analyze matrix proves
loose files and envelope round-trip, partial/malformed/future-schema evidence,
input bounds and duplicate rejection, prior-evidence retention, paired control
and distributed identity authority, abort/context safety, safe URL/filename
projection, search, Markdown, Control export/re-import, reload clearing,
unmount/remount persistence, all contract viewports, keyboard/focus, 44px
targets, reduced motion, announcements, overflow, and CSS isolation in both
legacy load orders.

Fresh exit evidence is 226/226 focused tests, 786/786 complete app tests,
shared-test and app TypeScript checks, a 551-module production build, 119
available Recipe Console Chromium tests with one configured-live skip, 28/28
preserved legacy navigation/ticket tests, and 57/57 control-server Deno tests.
Analyze's own four browser owners pass 19/19, including keyboard-owned picker,
actual drop, and activated legacy Runs/Shared Test destinations. The in-app
Browser was unavailable exactly as `No browser is available`;
Playwright/System Chromium is fallback evidence, not an in-app
Browser pass. Independent shared and app/state reviews closed every Important
finding and ended with no open Critical or Important issue.

Ready-State #6 is satisfied. Ready-State #3 remains open because the configured
Postgres-backed lifecycle is **skipped, not passed**, for exactly: `Set
RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
apps/rallar-black-box-control-server, and apps/rallar-black-box available.`

This proof does not hide or re-home `runner.runs`,
`legacy.distributed-recipes`, `legacy.shared-test-import`, or
`legacy.run-manager`. Their history, comparison, generic artifact, authoring,
replay, and administration responsibilities remain visible and reachable.
Analyze supplies explicit legacy Runs and Shared Test handoffs, while its own
inactive UI is unmounted and only the bounded root hook retains artifact bytes.

## Iteration 5 live Monitor implementation start — 2026-07-12

Independent contract, UI/browser, and control/live audits confirmed that the
approved Monitor composition is still backed entirely by a synthetic failed
seed and ignores the live distributed-run identity already preserved by Execute
and the v1 URL. The tests-first
[implementation plan](../../../docs/superpowers/plans/2026-07-12-rallar-recipe-console-monitor-workflow-implementation-plan.md)
therefore scoped replacement of only that seeded Recipe Console ownership with
the existing root control query and shared deterministic monitor/report/verdict
derivations.
The focused baseline passes 83/83 tests plus app typecheck.

The audits also found three correctness prerequisites: a partial distributed
refresh can discard otherwise coherent last-known evidence; the current
inspector applies first-failure cause/action copy to later selected failures;
and role-scoped recipe progress counts agents that the authoritative control
service does not dispatch that recipe to. Each receives shared or pure-state
RED/GREEN proof before React implementation. Monitor would use the current
credential-aware Cancel/artifact adapter, never raw fetch or a second poller,
and preserve exact context across all asynchronous responses.

At this historical implementation-start checkpoint, this was not cutover
evidence. `runner.runs` still owned
history, offline import/analysis, comparison, and local-run flows;
`legacy.distributed-recipes` still owned history, compare, diagnostics, and
authoring. `runner.distributed-monitor` was not code-backed until the named
failure-first, correlated-evidence, last-known, responsive, CSS-isolation, and
configured-live pass-or-exact-skip proofs completed. All legacy rows, mounts,
primary visibility, deep links, and rollback URLs remained unchanged.

## Iteration 5 live Monitor exit — `42eedae`

The explicit Recipe Console Monitor destination now owns the code-backed core
live-monitor workflow. It consumes the single root control query and shared
deterministic monitor/report/verdict derivations, keeps selected control and
distributed run identity in v1 URL state, presents current or honestly labelled
last-known evidence, and keeps verdict, affected identity, and next inspection
ahead of bounded timeline and event detail. Refresh, armed Cancel, artifact
Load, and artifact Export remain credential-aware root operations; partial,
stale, offline, authorization, credential-trust, terminal, and post-context-
change responses fail closed without a second poller or React-owned fetch.

The exact current acceptance evidence is:

- `tests/playwright/rallar-black-box/recipe-console-monitor.spec.ts` —
  `places the failure verdict and failure list before raw event evidence`;
  `opens all available correlated evidence from a failure row`; and
  `preserves last-known evidence while a selected run refresh fails`.
- `tests/playwright/rallar-black-box/full-stack-recipe-console-monitor.spec.ts`
  — `completes the configured live distributed run lifecycle and exports its artifact`.
- `tests/playwright/rallar-black-box/recipe-console-legacy-monitor-handoff.spec.ts`
  — `opens the selected legacy Runs context from a two-run Monitor link`.

The contextual legacy Runs proof supplies an older selected control/distributed
run pair alongside a newer run, follows `Open this run in legacy Runs`, and
verifies that the legacy combobox and freshness evidence retain the requested
older pair rather than falling back to collection order. The rollback URLs stay
exactly `/?workspace=black-box-runner&tab=runs` and
`/?workspace=black-box-runner&tab=distributed-recipes`; both owning legacy rows
remain visible, deep-linkable, uncut, and governed by their unchanged current
mount policies.

Final validation passes 229/229 focused tests; 708/708 complete app tests across
72 files; shared-test and SPA typechecks; a 507-module production build and
reciprocal experience-chunk assertion; 100 passed Recipe Console Chromium tests
plus one configured-live skip; 28/28 exact legacy navigation/ticket tests; and
control-server check plus 57/57 Deno tests. Desktop, tablet, 430×932 portrait,
932×430 landscape, keyboard, 44px targets, focus trap/restore, reduced motion,
announcements, contained scrolling, operational-state transitions, refreshed
Monitor baselines, and actual Monitor CSS in both load orders pass. The in-app
Browser was unavailable exactly as `No browser is available`; controlled
Playwright/System Chromium is the recorded fallback, not an in-app Browser pass.

Ready-State #4 and #5 are satisfied by the named failure-order and correlated-
evidence acceptances. Ready-State #3 remains open because the configured
Postgres-backed lifecycle is **skipped, not passed**, for exactly:
`Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1, apps/rallar-black-box-control-server, and apps/rallar-black-box available.` The
full-stack wrapper and canonical command now require a fresh Postgres API,
validate reachable API/control identity before allowing an unavailable skip,
and check a distinct non-terminal cancellation through per-target dispatched
and completed `recipe.cancel` evidence; those code guards do not substitute for
an executed configured-service pass.

This exit changes no primary navigation, current legacy mount policy, legacy
owner, public export, endpoint, default, or rollback route. `runner.runs` still
owns history, offline import/analysis, comparison, and local-run flows;
`legacy.distributed-recipes` still owns history, comparison, diagnostics, and
authoring. Their complete rows therefore remain operational strangler fallbacks
until later iteration-specific cutover proofs pass.

## Iteration 4 guided Execute implementation start — 2026-07-12

Authoritative contract and UI audits found that the current Execute surface
mixes the live Iteration 3 control board with seeded targets and preview-only
Stage/Start state. The tests-first
[implementation plan](../../../docs/superpowers/plans/2026-07-12-rallar-recipe-console-execute-workflow-implementation-plan.md)
therefore replaces that target/action plane with shared-fixture catalog facts,
fresh recipe-aware target derivation, validated manifest/resolution truth, and
credential-aware Resolve/Create/Stage/Start/Cancel/Refresh/Export operations.
Manual Start will remain disabled until authoritative state is `ready`, and
duplicate-session/capability blockers require shared deterministic evidence.

This is implementation work, not cutover evidence. `runner.recipes` still owns
agent setup, readiness, local launch, and compatibility flows;
`legacy.distributed-recipes` still owns history, Monitor, compare, and
authoring. Both rollback URLs, primary visibility, mounts, and deep links remain
unchanged until their complete named gates pass.

### Iteration 4 implementation checkpoint — `3fe2574`, `76092f6`

Shared-test now canonically owns repository recipe catalog projection,
configured group-aware recipes, combined manifest validation,
duplicate-session blocking, and exact selected-recipe CRDT transport truth.
Legacy catalog imports delegate through their existing paths, and legacy
target/agent-board flows now receive the selected recipes and synchronously
exclude newly unsafe targets from manifests. The final reviewed target slice
passed 95/95 focused tests plus shared-test and SPA typechecks.

Recipe Console now also exposes a narrow root-owned execution API for Resolve,
Create, Stage, Start, Cancel, and schema-v2 artifact export. It reuses the
Iteration 3 credential-origin policy while keeping read, write, and artifact
challenge state separate; no token, raw fetch, or control-run-manager
ownership enters Execute React code. The reviewed API slice passed 79/79
focused tests and SPA typecheck. The default shared-test Deno aggregate was
not counted as passed because manual node-modules mode could not resolve
`npm:@types/node`; the same seven entries passed with
`--node-modules-dir=none`.

At this implementation checkpoint these commits were foundations, not workflow
parity or cutover evidence. The seeded Execute target/action plane remained
until the pure workflow and visible lifecycle replacement passed at the exit
checkpoint below, and both legacy rows retained their primary visibility,
mounts, deep links, and rollback URLs.

Pure Execute state now also owns canonical recipe/default selection without
index fallback, URL dependency clearing, safe target-context reconciliation,
deterministic manifests and full fingerprints, exact resolution evidence,
explicit action arming/policy, mutation-response classification, and
newer-only query reconciliation. The final slice passed 104/104 focused tests,
SPA typecheck, bounded pure-module gates, and independent review. A review
found and corrected equal-millisecond stale-query overwrite of mutation truth;
terminal advancement remains the only equal-timestamp query exception. This
still changes no visible owner, row status, mount, hide, or rollback route.

## Iteration 4 guided Execute exit — `8d44a99`, `bddde71`

The explicit Recipe Console Execute destination now owns a bounded guided
workflow for repository recipe selection, profile filtering, target resolution,
preflight, read-only manifest inspection, Resolve, Create, Stage, Start,
Cancel, Refresh, and schema-v2 artifact export. The seeded target/action plane,
preview hook, duplicate generic agent board, and preview-only copy are removed.
The selected recipe drives every target and manifest fact, unsafe rows expose
their exact blocker reasons, target drift refuses Stage, and each fresh rerun
receives a new distributed run identity.

The root-owned control boundary remains the only raw transport owner. URL
selected control and API origins cannot receive ambient manual, session, or
brokered credentials; the runtime credential policy is required and fails
closed if omitted. Initial legacy-to-Recipe history transitions retain their
origin provenance, while legacy and `mode=control` ticket flows remain
compatible. Create, Stage, Start, Cancel, and Export reject stale post-await
responses after configuration changes, a post-mutation Refresh is guaranteed,
and reachable protocol, authorization, credential-trust, stale, partial, and
offline states remain distinct.

Exit evidence is 294/294 focused tests across 18 files, 656/656 complete app
tests across 67 files outside the socket-restricted sandbox, shared-test and
SPA typechecks, a 479-module production build, reciprocal experience-chunk
proof, 89 passed Recipe Console Chromium tests with one configured-live skip,
28/28 exact legacy navigation/ticket tests, and control-server check plus
57/57 Deno tests. Desktop, tablet, 430×932 portrait, 932×430 landscape,
keyboard-only paths, 44px targets, reduced motion, focus trap/restore,
contained scrolling, operational announcements, and actual Execute CSS in
both load orders pass. The in-app Browser was unavailable exactly as
`No browser is available`; controlled Playwright/System Chromium is recorded
as fallback, not as an in-app Browser pass. Independent code/contract and
browser/cutover review found one Critical and twelve Important issues across
their passes; all received RED/GREEN coverage before the fresh exit run.

The configured Postgres-backed lifecycle is **skipped, not passed**, for
exactly: `Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
apps/rallar-black-box-control-server, and apps/rallar-black-box available.` The
configured acceptance now exercises authenticated `browser-rallar` agents and
validates the exported artifact, but unavailable services cannot qualify it.
Live Monitor observation and a distinct live cancellation remain Iteration 5
work, so Ready-State #3 stays open. `runner.recipes` still owns agent setup,
readiness, and local launch; `legacy.distributed-recipes` still owns history,
Monitor, compare, and authoring. Both legacy rows therefore remain visible,
mounted by their preserved policies, deep-linkable, and uncut with unchanged
rollback URLs.

## Iteration 3 control connection and agent board exit — `a7df46f`

The explicit Recipe Console experience now owns a view-independent bounded
control query, announced operational context, URL-backed control-run/agent
selection, and a repository-derived agent board under
`src/recipe-console/control/**`. The query delegates to the existing canonical
control-run manager, retains last-good evidence without calling it current-safe,
stops its poll timer and requests when Recipe Console unmounts, and deeply
validates nested snapshot shapes and identity uniqueness before derivation.
Malformed core responses remain reachable protocol failures; malformed optional
distributed context becomes partial without discarding usable runs and agents.
Unavailable IDs remain visible rather than falling back to seeded or
first-collection data.

Deployment-configured endpoints may use configured manual or brokered
credentials. A URL-selected control endpoint receives only an anonymous request
unless that same incoming URL explicitly supplied `controlToken`; ambient
configured tokens and token brokering are withheld. A URL-selected API endpoint
never receives the stored auth session and cannot auto-consume an agent-session
ticket. Provenance is captured before sensitive Recipe Console query/hash fields
are synchronously scrubbed ahead of the login gate or lazy experience request.
Legacy and `mode=control` runner-agent links retain their existing ticket
behavior. After bootstrap, tokens remain memory-only.

Exit evidence is 155/155 focused tests, 567/567 complete app tests across 62
files outside the socket-restricted sandbox, app typecheck, a 458-module build,
reciprocal chunk proof, 64/64 Recipe Console Chromium tests,
28/28 exact legacy navigation/ticket tests, control-server check and 57/57
tests, shared-test TypeScript plus seven Deno entry checks using the documented
`--node-modules-dir=none` isolated-worktree workaround, and the reproducible 1/1
non-mutating standard-harness smoke
`RALLAR_BLACK_BOX_LOCAL_CONTROL_SMOKE=1 npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/control-foundation-local-smoke.spec.ts`
against the actual local control process. Desktop, tablet, 430×932 portrait,
932×430 landscape, keyboard, touch, reduced-motion, announcement, overflow,
poll-cleanup, CSS-isolation, credential-origin withholding, pre-lazy secret
scrubbing, ticket-origin safety, malformed snapshots, and reviewed visual proof
pass. The in-app Browser remained unavailable exactly as `Browser is not
available: iab`; discovery returned `[]`, so controlled Playwright/System Chrome
is the recorded fallback rather than an in-app Browser pass. Independent final
review found no Critical or Important issue.

The configured Postgres lifecycle remains **skipped, not passed**, for exactly:
`Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
apps/rallar-black-box-control-server, and apps/rallar-black-box available.`
The local GET smoke and Deno suite prove read/contract behavior only, not a
distributed lifecycle. At the Iteration 3 checkpoint the configured
`recipe-console-execute.spec.ts` acceptance was absent; visible create, stage,
start, monitor, cancel, and export plus the configured lifecycle proof remained
Iterations 4–5. The Iteration 4 exit above now adds the configured acceptance
and visible Execute controls. Live Monitor observation, a distinct live
cancellation, and the configured-service pass remain Iteration 5 work, so
Ready-State #3 stays open. This checkpoint changed no legacy route, alias, deep-link
semantics, default, navigation visibility, existing legacy mount policy,
rollback URL, endpoint, legacy owner, hide, or cutover. No existing export was
removed, renamed, or made incompatible; additive structured HTTP/protocol error
exports preserve message compatibility without changing the server protocol.
The deterministic Execute preview remained explicitly preview-only at this
checkpoint and was removed at the Iteration 4 exit above. The legacy default
remains until Iteration 12.

## Iteration 2 visual approval checkpoint — 2026-07-11

Direction A, **Signal Ledger**, is the approved Recipe Console visual and
interaction contract. Four concept states are checked in under
`docs/recipe-console-concepts/**`; the executable design contract is
`../../../docs/superpowers/specs/2026-07-11-rallar-recipe-console-signal-ledger-design.md`.
The concepts govern visual composition while repository fixtures and
deterministic derivations govern product data. The exit checkpoint below and
the [fidelity ledger](./recipe-console-iteration-2-fidelity-ledger.md) now hold
the implementation, CSS isolation, lazy-chunk, URL/history, accessibility,
responsive, and fidelity proof. The visual approval itself changes no row's
cutover, hide, mount, or rollback status.

## Iteration 2 shell exit checkpoint — `a397642`

The explicit `v=1&experience=recipe-console` route now owns a seeded Signal
Ledger shell under `src/recipe-console/**`. It is a separate lazy experience
closure from `LegacyExperience`; only one experience mounts at a time. Blank
URLs, old aliases, explicit legacy links, one-time runner-agent ticket flows,
and every rollback URL continue to resolve through the preserved legacy shell.
Advanced compatibility links cross the experience boundary without statically
importing a legacy React panel.

Exit evidence is 81/81 focused tests, typecheck, a 442-module build, reciprocal
chunk-closure proof, 40/40 Recipe Console Chromium tests, 28/28 exact legacy
navigation/ticket tests, and 460/460 complete app tests. Desktop, tablet,
430×932 portrait, and 932×430 landscape Browser-fallback QA cover URL/title,
meaningful DOM, focus, keyboard, touch, reduced motion, operational states,
overflow, and CSS load order. Four concept baselines pass a 1% drift budget.
The final independent review has no Critical or Important finding.

The installed in-app Browser was unavailable (`Browser is not available: iab`;
discovery `[]`), so system Chrome fallback is recorded rather than an in-app
pass. Live/Postgres coverage is skipped, not passed, for the exact reason:
`Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
apps/rallar-black-box-control-server, and apps/rallar-black-box available.`

This checkpoint cuts over, hides, removes, or re-homes **no workflow row**.
Recipe Console actions are local preview behavior; live control, execution,
monitoring, analysis, comparison, tuning, fleet, and Advanced replacements
remain owned by Iterations 3–11. The legacy default remains until Iteration 12.

## Iteration 1 extraction checkpoint — `63e7b2c`

This checkpoint records code ownership movement only; it does not change any
row's cutover, hide, mount, or rollback status.

| Slice | Current extracted owners | Parity evidence | Remaining ownership |
| --- | --- | --- | --- |
| Runner/distributed workflows | Focused modules under `src/legacy/runner/{advanced,builder,distributed,distributed-recipes,fleet,recipes,run-manager,runs,shared-test,workbench}/**`; mounted by the bounded shell tab groups | Exact controller/view/JSX/App/CSS locks, focused tests, builds, mutation probes, browser QA, and independent reviews through the Iteration 1 exit | No Iteration 1 ownership remains; Recipe Console workflow cutovers remain owned by Iterations 4–10. |
| Shared diagnostic evidence | Focused modules under `src/legacy/diagnostics/{events,rtc,topology}/**`; mounted by the direct/evidence/resource shell groups | Exact presentation, mount/lifetime, composition-DAG, and browser parity plus focused validation | No Iteration 1 ownership remains; lazy Advanced migration and stateful unmount proofs remain Iteration 11 work. |
| Quick Test | `QuickRallarTestPanel.tsx`, `QuickRallarTestView.tsx`, and `use-quick-rallar-controller.ts` | Controller/effect/JSX/mount parity; operational desktop/mobile QA | Its documented hidden-mounted subscription/state exception remains |
| RTC Realtime | `RtcRealtimePanel.tsx`, `RtcRealtimeView.tsx`, and `use-rtc-realtime-controller.ts` | Controller/effect/JSX/mount parity; operational desktop/mobile QA | Its documented hidden-mounted RTC ownership exception remains |
| WebSocket | Focused contracts/presets/routing/recipes/diagnostics, controller, view, and thin panel under `src/legacy/diagnostics/websocket/**` | Exact helper/controller/effect/JSX/runtime/App/CSS and operational parity through W3 | Socket/subscription lifetime exception remains; no hide/cutover occurred |
| Legacy shell, models, controllers, and composition | Focused leaves, global-context/ticket/runner models, pure fleet share-link builder, navigation/global-context controllers, two-phase runner shell state/sync, `LegacyAppShell`, drawer, contracts, and six tab groups under `src/legacy/**` | Exact component/model/controller/import/export/hook/order/DAG/App/CSS locks, 392/392 app tests, mutation probes, desktop/mobile/landscape/reduced-motion QA, 28/28 navigation/ticket browser proof, and independent reviews through `9c173d8`; reciprocal experience chunk proof at `a397642` | Iteration 1 complete at a 234-line App. Recipe Console and legacy are now separate lazy experience closures; stateful per-surface Advanced unmount/cutover proofs remain Iteration 11 work. |

At this checkpoint `App.tsx` is 9,242 lines, down from the 28,265-line
baseline. No surface has been newly hidden, no legacy deep link has changed,
and no temporary mounted-state exception is represented as resolved.

Worktree recovery note (2026-07-11): the OS removed the original
`/private/tmp` worktree after the committed WebSocket W3 cutover. The same
branch was recovered without history loss at the repository-ignored
`tmp/worktrees/rallar-black-box-spa` path. Recovery verification passed 65/65
focused tests and typecheck at `5d86e17`; `App.tsx` is 8,012 lines. This changes
no surface cutover, hide, mount, rollback, or deep-link status.

Media M1 ownership checkpoint (2026-07-11): the exact private Media console is
now owned by
`src/legacy/diagnostics/media/MediaConsolePanel.tsx` (457 lines), reducing
`App.tsx` to 7,575 lines. Tests-first extraction proof, 57/57 focused tests,
typecheck/build, declaration/cleanup/action/JSX mutation probes, desktop and
mobile Playwright, hidden-mounted lifetime/state checks, and independent review
passed. The exhaustive live-service scenario was skipped because the required
Postgres-backed API, control server, and app stack were unavailable. Landscape
action controls remain 30px high and are registered Iteration 12 touch-target
debt. This checkpoint changes no row's cutover, hide, mount, rollback, or
deep-link status; `direct.media` retains its temporary stateful exception.

Rallar Data M1 ownership checkpoint (2026-07-11): the exact private Data types
and complete console are now owned by
`src/legacy/diagnostics/rallar-data/RallarDataPanel.tsx` (670 lines), reducing
`App.tsx` to 6,927 lines. Tests-first fallback proof, 58/58 focused tests, the
77/77 listed Iteration 1 slice, typecheck/build, cleanup/dispatch/JSX/mount
mutation probes, in-app Browser and reduced-motion multi-viewport Playwright,
and two independent reviews passed. The exhaustive live Data lifecycle was
skipped because the Postgres-backed API/control/app full stack was not enabled.
Desktop and landscape action controls remain 30px and are registered Iteration
12 touch-target debt. This changes no cutover, hide, mount, rollback, or
deep-link status; `direct.rallar-data` retains its temporary open-store and
change-listener exception.

Auth M1 ownership checkpoint (2026-07-11): the exact diagnostic panel is now
owned by `src/legacy/diagnostics/auth/AuthCommandCenterPanel.tsx` (518 lines),
with focused recipe, REST action-log, and safe session-read seams, reducing
`App.tsx` to 6,361 lines. Login/bootstrap, facade subscription, one-time ticket
consume/scrub, context synchronization, gates, and logout orchestration remain
App-owned. Tests-first fallback proof, 93/93 combined validation,
typecheck/build, credential/redaction/JSX/mount mutations, in-app Browser,
simulated command-center actions, reduced-motion multi-viewport Playwright, and
two independent reviews passed. The exhaustive live Auth/Groups flow was
skipped because the Postgres-backed full stack was not enabled. Action controls
remain 42px and are registered Iteration 12 debt. This changes no cutover,
hide, mount, rollback, or deep-link status; `direct.auth` retains its temporary
hidden-mounted draft/history exception.

Groups/Clients R1 ownership checkpoint (2026-07-11): exact action/sort/state
contracts and constants are now owned by
`src/legacy/diagnostics/rooms-clients/rooms-clients-contracts.ts` (216 lines),
deterministic snapshot/event normalization and sorting by
`rooms-clients-derivations.ts` (292 lines), and the shared deep string lookup by
`diagnostics/shared/deep-string-value.ts` (32 lines), reducing `App.tsx` to
5,848 lines. The complete stateful panel/controller, direct and REST actions,
mount, and lifecycle remain App-owned. Tests-first fallback proof, 87/87
combined validation, typecheck/build, four mutation probes, in-app Browser,
the preserved operational flow, reduced-motion multi-viewport QA, and two
independent reviews passed. The exhaustive real Groups/Clients lifecycle was
skipped because the Postgres-backed full stack was not enabled. Arrow keys
select tabs but do not transfer DOM focus; that existing behavior is registered
as Iteration 12 accessibility debt. This changes no cutover, hide, mount,
rollback, or deep-link status for `direct.groups-clients`.

Groups/Clients R2 ownership checkpoint (2026-07-11): the complete 1,063-line
stateful surface is now split into the 51-line request helper, 698-line
controller, 534-line exact view, and 17-line root under
`src/legacy/diagnostics/rooms-clients/**`, reducing `App.tsx` to 4,711 lines and
leaving App with only the thin root import. The exact controller/effects,
REST/direct actions, derived model, JSX/DOM, App mount, and hidden ancestor are
preserved, so the existing hidden-mounted draft/result/filter lifetime remains
in force. Tests-first fallback proof, 88/88 combined validation,
typecheck/build, four mutation probes, in-app Browser, the preserved
operational flow, reduced-motion multi-viewport QA, and two independent reviews
passed. The exhaustive real lifecycle was skipped because the Postgres-backed
full stack was not enabled. Action controls remain 42px and keyboard selection
still does not hand focus to the selected tab; both are registered Iteration 12
debt. This changes no cutover, hide, mount, rollback, or deep-link status for
`direct.groups-clients`.

Rallar Server M1 ownership checkpoint (2026-07-11): the complete workbench is
now owned by the 14-line contract, 34-line parsers, 84-line feedback panel,
762-line controller, 561-line view, and 18-line root under
`src/legacy/diagnostics/rallar-server/**`, reducing `App.tsx` to 3,433 lines
and leaving App with only the thin root import. The exact 55 controller
statements, 25 state slots, seven memos, three effects, REST/runtime actions,
redaction, JSX/DOM, App mount, and hidden ancestor are preserved. Tests-first
fallback proof, 107/107 final focused validation, typecheck/build, six semantic
mutation probes, in-app Browser, five simulated browser scenarios,
reduced-motion multi-viewport QA, and two independent final reviews passed.
The two exhaustive Postgres scenarios were skipped, not passed, for this exact
reason: `Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
apps/rallar-black-box-control-server, and apps/rallar-black-box available.` The
four general full-stack scenarios were separately skipped, not passed, for this
exact reason: `Set RALLAR_BLACK_BOX_FULL_STACK=1 and provide either Postgres
env files or RALLAR_BLACK_BOX_API_MODE=memory for apps/api-v1 full-stack Rallar
Black Box tests.` Invalid editable JSON, OpenAPI presets, feedback,
response/collection results, and busy/error state remain part of the temporary
hidden-mounted exception alongside redacted persisted drafts. Action controls
remain 42px, and keyboard selection still does not hand focus to the selected
tab; both remain Iteration 12 debt. This changes no cutover, hide, mount,
rollback, route, alias, public export, server contract, navigation, or
deep-link status for `direct.rallar-server`.

CRDT M1 ownership checkpoint (2026-07-11): the complete editor and admin-health
surface is now split across the 37-line contracts owner, 343-line editor
controller, 283-line board view, 240-line entities view, 302-line editor
composition, 297-line health controller, and 290-line health panel under
`src/legacy/diagnostics/crdt/**`, reducing `App.tsx` to 1,849 lines and leaving
App with only the health-panel root import. Exact controller/hook/cleanup,
actions, redaction, JSX/DOM, nested editor and App mount lifetimes, hidden
ancestor, and stylesheet parity remain locked. Tests-first fallback proof,
100/100 final focused validation, typecheck/build, five semantic mutation
probes, in-app Browser, reduced-motion multi-viewport QA, and two independent
reviews passed. The exhaustive CRDT scenario was skipped, not passed, for this
exact reason: `Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed
apps/api-v1, apps/rallar-black-box-control-server, and apps/rallar-black-box
available.` The retained exception explicitly includes transient editor
inputs/results, the active document/subscription, and the health controller's
busy action, error, documents, selected key, and last result. Portrait CRDT
content remains 807px wide at a 430px viewport, desktop/landscape actions
remain 30px, and arrow-key selection does not hand focus to the selected tab;
these unchanged behaviors remain Iteration 12 debt. This changes no cutover,
hide, mount, rollback, route, alias, public export, server contract,
navigation, or deep-link status for `direct.crdt`.

Legacy shell L1 ownership checkpoint (2026-07-11): the exact login, run
header, tabs, global-context bar, mode switch, direct-operation boundary, and
runner boundary now live in seven focused owners under `src/legacy/shell/**`,
reducing `App.tsx` to 1,065 lines while leaving the complete 833-line App
function unchanged. The owner gate locks exact imports and type/value kinds,
exports/top-level inventory, component AST, hook topology, transitive local
acyclicity, App AST, and stylesheet parity. Tests-first fallback proof, 75/75
final focused validation, typecheck/build, five semantic/ownership mutation
probes, existing desktop/mobile flows, a 3/3 reduced-motion desktop/portrait/
landscape matrix, and independent review passed. The two exhaustive
authenticated shell scenarios were skipped, not passed, for this exact reason:
`Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
apps/rallar-black-box-control-server, and apps/rallar-black-box available.`
No route, alias, deep link, App mount, hidden-mounted exception, stylesheet,
navigation visibility, default, hide, rollback, or cutover status changed.
Pure models, focused shell controllers, tab composition, `LegacyAppShell`, and
the below-800 App boundary remain before Iteration 1 can exit.

Legacy shell models M1 ownership checkpoint (2026-07-11): exact runner queue
and result-selection derivation now lives in the 46-line
`src/legacy/runner/shell/runner-shell-model.ts`; global-context derivation,
equality, and bootstrap patching live in the 69-line
`src/legacy/shell/global-context-model.ts`; and ticket scrubbing, in-flight
deduplication, and settlement cleanup live in the 47-line
`src/legacy/shell/auth/agent-session-ticket.ts`. This reduces `App.tsx` to 926
lines while leaving its exact 833-line function, eight state slots, eight
effects, complete tab tree, mounts, guards, routes, aliases, styles, and
contracts unchanged. Tests-first ownership proof began with exactly 19
intended failures; final focused validation passed 100/100, typecheck/build
passed, five semantic/ownership mutations were caught, the focused Chromium
ticket workflow passed 1/1, and two independent reviews approved the slice at
`0939161`. The prior L1 multi-viewport, keyboard, reduced-motion,
operational-state, and CSS-isolation proof remains valid through the exact App
and stylesheet locks. Exhaustive authenticated shell coverage remains
unavailable and is not represented as passed for this exact reason: `Set
RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
apps/rallar-black-box-control-server, and apps/rallar-black-box available.` No
surface is cut over or newly hidden. Focused controllers, the fleet share-link
builder, tab composition, `LegacyAppShell`, and the below-800 App boundary
remain before Iteration 1 can exit.

Fleet share-link M2 ownership checkpoint (2026-07-11): deterministic share URL
construction now lives in `buildFleetShareUrl(...)` under
`src/legacy/runner/fleet/fleet-helpers.ts`; the controller owns only the
clipboard side effect. Exact mode/tab targeting, filter and map-layer
serialization, unrelated query values, ordering, and fragment preservation
are covered by the focused behavior and AST gates. Validation passed 48/48,
typecheck/build passed, and a route-target mutation was caught at `ff79d28`.
This completes share-link ownership without changing App size, routes, mounts,
navigation, cutover, public exports, or server contracts. Focused shell
controllers, tab composition, `LegacyAppShell`, and the below-800 App boundary
remain.

Legacy shell controllers M3 ownership checkpoint (2026-07-11): navigation and
popstate ownership now live in the 79-line `use-legacy-navigation.ts`, global
context synchronization and update/reset ownership in the 128-line
`use-command-center-global-context.ts`, and runner queue/history/clock,
selection, distributed handoff state, and late sync/persistence in the 75-line
`use-runner-shell-state.ts`. This reduces `App.tsx` to 759 lines with three
direct auth state slots, four direct auth/bootstrap effects, and no direct
memo/ref, satisfying the below-800 checkpoint while preserving the exact
transitive effect order and complete JSX/style tree. The final focused slice
passed 108/108; typecheck/build passed; five semantic mutations were caught;
Chromium passed 28/28 navigation, operational, persistence, and ticket flows;
and independent review approved `0ecade8`. Exhaustive authenticated shell
coverage remains unavailable and is not represented as passed for this exact
reason: `Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
apps/rallar-black-box-control-server, and apps/rallar-black-box available.` No
route, alias, mount, hide, cutover, public export, server contract, or style
changed. Focused tab groups and a thin `LegacyAppShell` remain before Iteration
1 can exit.

Legacy shell composition M4 and Iteration 1 exit checkpoint (2026-07-11):
`App.tsx` is now 234 lines and owns runtime/bootstrap, three auth state slots,
four auth/bootstrap effects, the shared navigation/global-context/runner-shell
controllers, auth gates, and one `LegacyAppShell` mount only. The 119-line
shell delegates the unchanged 24-section tree through a 49-line drawer, a
28-line type-only contract, and six hook-free groups of 52–179 lines. Exact
imports, type/value kinds, owner inventories, acyclic edges, section order,
ARIA links, six active-only guards, 18 hidden-mounted lifetimes, panel props,
App/auth topology, and stylesheet bytes are executable constraints.

The exact Iteration 1 command passed 82/82, the complete app unit run passed
392/392 across 50 files, typecheck passed, and the 396-module build passed with
the existing 1,264.61 kB default-chunk warning. Chromium passed 28/28 focused
navigation, deep-link, operational, persistence, session, and ticket flows;
mobile portrait passed 1/1; 932x430 landscape, keyboard, reduced-motion, and
DOM/CSS compatibility checks passed with the already-registered focus-transfer
debt unchanged. Six controlled mutation scenarios were caught and restored,
and two final independent reviews reported no findings. This evidence is
anchored by `9c173d8`.

Exhaustive authenticated/live-service coverage was skipped and is not
represented as passed for this exact reason: `Set RALLAR_BLACK_BOX_FULL_STACK=1
with Postgres-backed apps/api-v1, apps/rallar-black-box-control-server, and
apps/rallar-black-box available.` No route, alias, navigation visibility,
mount, hide, cutover, rollback, public export, control-server contract, or
style changed.

| Stable surface groups | Current legacy composition owner | Exit mount policy |
| --- | --- | --- |
| `runner.recipes`, `runner.runs`, `runner.fleet`, primary `runner.builder`, `runner.advanced-wrapper` | `src/legacy/shell/tabs/RunnerWorkspaceTabPanels.tsx` | Recipes/Runs/Fleet/Builder remain active-only; Advanced remains hidden-mounted. |
| `direct.quick-test`, `direct.auth`, `legacy.manual-rallar`, `direct.groups-clients`, `direct.websocket`, `direct.rtc-realtimes`, `direct.topology`, `direct.rtc-diagnostics` | `src/legacy/shell/tabs/DirectConnectionTabPanels.tsx` | All remain hidden-mounted; Topology still receives its exact active signal. |
| `direct.rallar-data`, `direct.crdt`, `direct.media` | `src/legacy/shell/tabs/DirectResourceTabPanels.tsx` | All documented stateful lifetimes remain hidden-mounted. |
| `legacy.local-workbench`, `legacy.run-manager`, `legacy.distributed-recipes` | `src/legacy/shell/tabs/RunnerCompatibilityTabPanels.tsx` | Workbench remains hidden-mounted; Run Manager and Distributed Recipes remain exact active-only compatibility mounts. |
| `direct.rallar-trace`, `direct.event-stream`, `direct.rallar-server` | `src/legacy/shell/tabs/DiagnosticEvidenceTabPanels.tsx` | All remain hidden-mounted. |
| Compatibility `runner.builder`, `legacy.shared-test-catalog`, `legacy.shared-test-import` | `src/legacy/shell/tabs/LegacyCompatibilityTailTabPanels.tsx` | Both compatibility sections remain hidden-mounted. |

## Compatibility inputs that must remain deterministic

| Compatibility input | Required destination during migration | Exact compatibility URL |
| --- | --- | --- |
| `tab=manual-rallar` | `advanced/manual` | `/?workspace=black-box-runner&tab=manual-rallar` |
| `tab=local-workbench` | `advanced/workbench` | `/?workspace=black-box-runner&tab=local-workbench` |
| `tab=run-manager` | `advanced/run-manager` | `/?workspace=black-box-runner&tab=run-manager` |
| `tab=distributed-recipes` | `advanced/distributed` | `/?workspace=black-box-runner&tab=distributed-recipes` |
| `tab=shared-test` | `advanced/shared-test` | `/?workspace=black-box-runner&tab=shared-test` |
| `tab=flow-builder` | `builder` | `/?workspace=black-box-runner&tab=flow-builder` |

`advancedSurface` and `advanced` accept `manual`, `workbench`, `run-manager`, `distributed`, or `shared-test`. `workspace` and `appMode` remain equivalent compatibility inputs. The alias resolver must open the documented surface rather than guessing a new Recipe Console view.

## Surface register

| Stable surface ID | Current component(s); route/query aliases | Complete current responsibility | Destination | Target code owner/path | Current mount policy | Target mount policy | State/persistence and temporary exception | Parity/cutover status | Exact cutover proof | Exact rollback URL | Evidence/status date |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `shell.global-context` | 260-line `App` bootstrap/auth/experience glue plus `LegacyAppShell`, focused shell leaves, drawer, six tab groups, global-context model, agent-ticket service, runner shell model, and `RallarBrowserTraceBar` under `src/legacy/{shell,runner/shell}/**`; blank URL or any route | Bootstrap/auth gate, provider/runtime/control status, global application/workspace/group/client/session context, workspace/tab navigation, first failure, always-available trace summary, shared runtime-store subscription, queue/selection derivation, and agent-ticket consumption. | Shell infrastructure | `src/recipe-console/{app,control}/**`, with bootstrap/provider glue retained in `src/App.tsx` | App/runtime bootstrap stays mounted. `LegacyExperience` and its shell mount only while the legacy experience is active; inside that experience the exact shell order, guards, and 18 stateful hidden lifetimes remain locked through M4. Blank URLs still resolve to stored navigation or direct Rallar `quick-test`. | Recipe Console shell is the final default; legacy shell is a separate lazy experience. Shared services outlive views, not legacy component trees. | URL/shareable state moves to the v1 codec. Only personal defaults remain local. Legacy and `mode=control` ticket consumption stay compatible. On Recipe Console cold entry, a URL-selected API origin disables automatic ticket consumption and sensitive query/hash fields are synchronously scrubbed; stored credentials remain excluded from URL persistence. | Iteration 1 shell/model/controller/composition extraction is complete with exact parity. Iteration 2 adds mutually exclusive lazy experience mounts. Iteration 3 adds root-owned control connection, command context, credential-origin policy, and synchronous secret scrubbing only on the explicit Recipe Console route, without a workflow cutover, primary hide, legacy/default behavior change, existing legacy mount change, or default flip. | `tests/playwright/rallar-black-box/recipe-console-shell.spec.ts` — `blank URL opens Recipe Console Execute only after all ready-state gates`; `tests/playwright/rallar-black-box/recipe-console-history.spec.ts` — `explicit URL wins over stored legacy navigation` | `/?experience=legacy&workspace=rallar&tab=quick-test` (supported pre-v1 alias: `/?workspace=rallar&tab=quick-test`) | Focused shell/model/composition owners, `App.tsx`, `app-tabs.ts`, `runtime-store.ts`; `9c173d8`; `a7df46f`; 2026-07-12 |
| `runner.recipes` | `RunnerRecipesPanel`, `RunnerReadinessPanel`, `RunnerAgentSetupPanel`, `ControlAgentBoardPanel`; `/?workspace=black-box-runner&tab=recipes`, aliases `catalog`, `recipes` | Service/auth/TURN/control readiness, agent launch/setup and identity board, recipe catalog/search/profile/source filters, preflight, target resolution, local launch, distributed create/stage/start handoff, and visible failure/status feedback. | `Execute` | `src/recipe-console/execute/**` and `src/recipe-console/control/**` | Existing consolidated primary tab; mounted only while `recipes` is active. | Lazy route, unmounted when inactive; polling/query lifecycle owned by control services. | Preserve selected recipe/profile as URL/personal default as appropriate; never persist control tokens. Runner-agent launch URL and ticket fragment behavior are compatibility constraints. | Iteration 4 guided Execute passes repository recipe selection, target resolution, preflight, read-only manifest, Resolve/Create/Stage/Start/Cancel/Refresh/export, URL restoration, and simulated distributed lifecycle proof. The legacy runner still owns agent setup, readiness, and local launch, so its row remains visible and uncut. | `tests/playwright/rallar-black-box/recipe-console-execute.spec.ts` — `runs a simulated distributed ACK recipe through visible controls`; `diagnoses non-targetable agents before staging`; `restores an existing Execute run from a copied v1 URL`; configured-live acceptance skipped with its exact environment reason | `/?workspace=black-box-runner&tab=recipes` | `src/recipe-console/execute/**`, `control-run-manager.ts`, `runner-agent-launch.ts`; `bddde71`; 2026-07-12 |
| `runner.runs` | `RunnerRunsPanel`, `RunVerdictPanel`, `CausalTrailPanel`, `RtcPerformancePanel`, `DistributedRunSummary`, participant board; `/?workspace=black-box-runner&tab=runs`, alias `runs` | Select and refresh live/historical distributed runs, retain last run handoff, import/export/copy artifacts, show local verdict/failures/report, select synthetic evidence, and compose nested monitor/analyze/compare surfaces. | `Monitor`, `Analyze`, and `Tune` | `src/recipe-console/{monitor,analyze,tune,history}/**` with selection/query adapters under `src/recipe-console/control/**` | Existing consolidated primary tab; mounted only while `runs` is active. It polls a selected non-terminal run and auto-loads terminal artifacts. | Monitor and Analyze UI unmount while inactive; Tune/History is a separate lazy entry that unmounts while inactive. Root query/retained-artifact services alone outlive views. | Selected run, control run, filters, comparison, and timing metric belong in URL state. Tokens and artifact payloads stay in memory. Poll ownership must move before unmounting. | Iterations 5–8 qualify bounded live monitoring, distributed artifact analysis, real tuning/comparison, server History, saved filters, and guarded preview-first retention through root query and retained-artifact authority. Canonical History browser acceptance now passes. Generic/local-run responsibility remains legacy-owned, so the row stays visible, deep-linkable, uncut, and active-only. | **Capability evidence passed:** canonical Monitor, Analyze, Tune, copied-URL History, and guarded retention cases; 147/148 Recipe Console cases and 28/28 legacy navigation/ticket cases at the Iteration 8 exit. **Full row cutover still pending:** remaining generic/local-run responsibility and configured-live proof. | `/?workspace=black-box-runner&tab=runs` | `src/recipe-console/{monitor,analyze,tune,history}/**`, `src/legacy/runner/runs/legacy-run-url-selection.ts`, `control-run-manager.ts`; `42eedae`, `47c332d`, `cc17169`, `382df72`, `fd9055e`, `f762749`; 2026-07-13 |
| `runner.distributed-monitor` | `DistributedRunMonitorPanel`, nested composite/timeline/diagnostic/progress views inside `RunnerRunsPanel` and `DistributedRecipesPanel`; runs/distributed routes | Verdict, failure-first evidence, agent/recipe progress, ACK/barrier readiness, lifecycle timeline, structured WS/RTC diagnostics, latency, event filtering, composite loop/parallel/wait/assert drilldowns, and artifact validation. | `Monitor` | `src/recipe-console/monitor/**`; deterministic derivation remains in `packages/shared-test/rallar-bb-test/**` | Mounted only with its owning active runs/distributed tree and selected monitor. | Lazy `Monitor` route; inactive view unmounted; shared deterministic helpers only. | Selection/filter fields use v1 URL state. No duplicate monitor derivation in React. | Iteration 5 core Monitor is code-backed for failure-first current/last-known truth, selected-failure correlations, progress/readiness, and current-safe actions. Iteration 9 adds exact-revision indexed reuse and browseable main/inspector windows for every pressured collection, exact omission/cardinality truth, complete stable-ID traversal, touch/reduced-motion proof, and post-refresh focus priority through `f8cef95`. Ready-State #10 is code-backed. This remains capability evidence, not a cutover or hide: both owning legacy workflow rows stay visible and operational. | `tests/playwright/rallar-black-box/recipe-console-monitor.spec.ts` — `places the failure verdict and failure list before raw event evidence`; `opens all available correlated evidence from a failure row`; `preserves last-known evidence while a selected run refresh fails`; `tests/playwright/rallar-black-box/recipe-console-monitor-windowing.spec.ts` — all nine bounded traversal/focus/touch cases; `tests/playwright/rallar-black-box/recipe-console-scale.spec.ts` — `keeps synthetic large event and result lists bounded responsive and searchable` | `/?workspace=black-box-runner&tab=runs` or `/?workspace=black-box-runner&tab=distributed-recipes` | `src/recipe-console/monitor/**`, indexed Control/board consumers, `packages/shared-test/rallar-bb-test/**`; `42eedae`, `8c630fc`, `66a16fd`, `f8cef95`; 2026-07-14 |
| `runner.artifact-analysis` | `DistributedRunAnalysisReportPanel`, `ImportedDistributedArtifactAnalysisPanel`, artifact import in `RunnerRunsPanel`; runs route | Live/offline artifact parsing, causal/failure report, missing-file and parse warnings, issue-ready summary/fix/performance markdown, and first actionable failure focus. | `Analyze` | `src/recipe-console/analyze/**`; validators/parsers in `packages/shared-test/rallar-bb-test/**` | Mounted only under active Runs when analysis exists. | Analyze is eager within the Recipe Console chunk, but its UI is unmounted when inactive; a bounded root hook retains imported bytes only in memory across Recipe Console view navigation. | Profile/version-aware parsing; partial bundles remain usable. Never persist large artifacts locally. Unsafe artifact identities stay out of URLs and filenames. | Iteration 6 makes the bounded distributed-run Analyze replacement code-backed for local/control import, failure-first analysis, search, quality/performance, Markdown, and export. Iteration 9 adds one parsed worker pipeline, a complete retained catalog, exact omission/search-state truth, at most 64 mounted rows, and zero inactive-view search/options work. The 15,000-row production acceptance and profile pass through `f8cef95`; Ready-State #10 is code-backed. Legacy Runs still owns local-run composition and generic Shared Test remains visible, so no row is hidden or cut over. | `tests/playwright/rallar-black-box/recipe-console-analyze.spec.ts` — `imports a partial bundle offline and focuses the first actionable failure`; `recipe-console-analyze-safety.spec.ts`; `recipe-console-analyze-visual.spec.ts`; `recipe-console-analyze-handoff.spec.ts`; `recipe-console-scale.spec.ts` — `keeps synthetic large event and result lists bounded responsive and searchable` | `/?workspace=black-box-runner&tab=runs`; generic fallback `/?workspace=black-box-runner&tab=shared-test` | `src/recipe-console/analyze/**`, `packages/shared-test/rallar-bb-test/**`; `f96b5b4`, `abe257e`, `9b07330`, `47c332d`, `6d90061`, `796fa59`; 2026-07-14 |
| `runner.compare` | `DistributedRunComparePanel`, `DistributedCompareList`, `compareDistributedRuns`; runs route | Select two runs and show status, recipe, participant, failure, timing, and received-message deltas. | `Tune` | `src/recipe-console/{tune,history}/**`; shared compare/tuning derivation in `packages/shared-test/rallar-bb-test/**` | Mounted only when Runs is active and at least two runs exist. | Lazy `Tune` route, unmounted when inactive. | `compareLeft`, `compareRight`, and `timingMetric` are v1 URL state; candidate changes are explicit output and never silent mutation. | Iteration 7 qualifies bounded explicit comparison; Iteration 8 qualifies History selection, copied-URL restoration, and selective post-cleanup reconciliation. The legacy comparison remains visible and uncut as an intentional fallback; no hide is required or authorized by this iteration. | **Capability evidence passed:** exact Tune comparison/mutation tests plus `recipe-console-history.spec.ts` — `restores versioned view selection filters comparison and timing metric from a copied URL` and guarded retention cleanup. | `/?workspace=black-box-runner&tab=runs` | `src/recipe-console/{tune,history}/**`, `packages/shared-test/rallar-bb-test/**`; `cc17169`, `382df72`, `fd9055e`; 2026-07-13 |
| `runner.fleet` | `RunnerFleetPanel`, `FleetTimingGroupList`, `FleetTimingStrip`; `/?workspace=black-box-runner&tab=fleet`, aliases `fleet-report`, `fleet-reports` | Live agent board, historical matrix/heatmap, filters, failure signatures, region/provider summaries, timing distributions, deterministic SVG world map and explicit route layers, and report/bundle export. | `Fleet` | Existing extracted fallback under `src/legacy/runner/fleet/**`; new `src/recipe-console/fleet/**` using shared deterministic helpers under `packages/shared-test/rallar-bb-test/**` | Existing consolidated primary tab; active-only mount and active fetch/rebuild lifecycle. | The behavior-preserving legacy controller/view remains active-only; the separate Recipe Console Fleet route is lazy/unmounted, consumes the root query, and never imports the legacy panel. | `fleetRegion` and `fleetMapLayers` use typed v1 URL state. Explicit coordinates/documented lookups remain evidence rules; unresolved locations are not guessed, routes require explicit target-agent evidence, and opaque artifact refs are never treated as URLs. | Iteration 10 is code-backed through `0088be0` and `3ab86a9`. Tolerant validation, shared indexed analysis/geography, bounded one-bundle transfer, complete browseable windows, live/historical authority, secondary map, exact handoffs, Direction A responsive/accessibility/CSS/chunk proof, canonical browser acceptance, and five visual baselines pass fresh qualification. Existing legacy navigation, rebuild/export, aliases, rollback, and active-only mount stay operational and visible; no cutover or hide. | `tests/playwright/rallar-black-box/recipe-console-fleet.spec.ts` — `restores fleet filters and map layers and links a failure signature to its run evidence`; preserved `tests/playwright/rallar-black-box/fleet-reporting.spec.ts` | `/?workspace=black-box-runner&tab=fleet` | `src/legacy/runner/fleet/**`, `src/recipe-console/fleet/**`, `packages/shared-test/rallar-bb-test/**`, `control-run-manager.ts`; `9e5b4b5`, `7d25ab9`, `0d046ca`, `0088be0`, `3ab86a9`; 2026-07-14 |
| `runner.builder` | `FlowBuilderPanel`; `tab=builder` (alias `flow`) and compatibility `tab=flow-builder` (alias `flows`) | Compose HTTP, WS, RTC, wait, cleanup, variables, editable flow JSON, SPA recipe export, runner scenario export, schema feedback, and inline recipe execution. | `Advanced` | First `src/legacy/runner/LegacyBuilderRoute.tsx`; focused authoring entry points may live under `src/recipe-console/advanced/**` | Primary `builder` instance is active-only, but a second legacy `flow-builder` pane remains mounted while hidden. | One lazy legacy route, unmounted inactive; any future focused authoring route delegates to shared schema helpers. | Flow JSON/drafts need explicit redacted persistence before removing the temporary stateful mount. No silent recipe mutation. | Existing consolidation to Builder; no Recipe Console cutover or new hide. | `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts` — `opens Flow Builder through tab=flow-builder and preserves an edited flow across the compatibility round trip` | `/?workspace=black-box-runner&tab=flow-builder` | `App.tsx`, `app-tabs.ts`, `current-state.md`; 2026-07-10 |
| `runner.advanced-wrapper` | `RunnerAdvancedPanel`; `tab=advanced` (alias `debug`) with `advancedSurface=<surface>` or `advanced=<surface>` | Switch and deep-link among Workbench, Distributed Recipes, Run Manager, Manual Rallar, and Shared Test raw controls. | `Advanced` | `src/recipe-console/advanced/**` plus `src/legacy/LegacySurfaceRouter.tsx` and registry | Wrapper is mounted even when Advanced is hidden; Workbench and Manual children remain mounted while hidden; other children are selected-only. | Lazy compatibility router mounts exactly one selected legacy route. | Surface selection uses v1 `legacySurface`. Stateful exceptions remain documented per child until persistence/service ownership is proven. | Existing consolidated wrapper only; no Recipe Console cutover. | `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts` — `loads exactly one registered advanced legacy route and restores Recipe Console context on return` | `/?workspace=black-box-runner&tab=advanced&advancedSurface=workbench` | `App.tsx`, `app-tabs.ts`; 2026-07-10 |
| `legacy.manual-rallar` | `ManualRallarWorkbenchPanel`, inbox/history; `tab=manual-rallar` (alias `manual`) → advanced/manual | Configure/join/connect/send/health/close/reset, scoped RTC and delivery matrices, NACK/negative probes, recipe/command export, received data, and command history. | `Advanced` | `src/legacy/runner/LegacyManualRallarRoute.tsx` | Two hidden-capable instances exist; Advanced Manual and the legacy pane stay mounted to preserve drafts/runtime context. | Lazy/unmounted inactive only after explicit redacted draft persistence and runtime-task ownership are proven. | **Temporary stateful exception:** Manual values/payload draft and active runtime work; passwords stripped and JSON redacted. | Preserved legacy; no replacement, cutover, or new hide. | `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts` — `tab=manual-rallar opens advanced manual and preserves redacted drafts without persisting secrets` | `/?workspace=black-box-runner&tab=manual-rallar` | `App.tsx`, `app-tabs.ts`, `current-state.md`; 2026-07-10 |
| `legacy.local-workbench` | `WorkbenchPanel`, `ControlPanel`, bootstrap/configuration/queue/report panels; `tab=local-workbench` (aliases `workbench`, `local`) → advanced/workbench | Local/fake runtime recipe editing/loading/execution/cancel/reset, queue, bootstrap/config, report, and control-agent workspace used by runner-agent launch URLs. | `Advanced` | `src/legacy/runner/LegacyWorkbenchRoute.tsx`; runtime service remains `runtime-store.ts` until deliberately extracted | Advanced and legacy compatibility trees remain mounted while hidden; shared runtime store is process-long. | Lazy/unmounted route after drafts and active execution are owned outside the view; service may remain alive. | **Temporary stateful exception:** recipe/command drafts and active local execution. Preserve `mode=control` launch bootstrap and fragment ticket scrubbing. | Preserved legacy; no replacement, cutover, or new hide. | `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts` — `runner-agent launch URL opens advanced workbench consumes and scrubs the session-ticket fragment` | `/?workspace=black-box-runner&tab=local-workbench` | `App.tsx`, `runner-agent-launch.ts`, `runtime-store.ts`; 2026-07-10 |
| `legacy.run-manager` | `RunManagerPanel`; `tab=run-manager` (aliases `manager`, `control`, `orchestrator`) → advanced/run-manager | Control-server run/agent selection, bounded snapshots, bulk command enqueue, reset/delete, command/result/event inspection, artifact validation/export/copy, JSONL, and failure bundle operations. | `Advanced` | `src/legacy/runner/LegacyRunManagerRoute.tsx`; API calls remain canonical in `control-run-manager.ts` | Selected-only under Advanced; compatibility pane also guards mount by exact legacy tab. | Lazy/unmounted inactive; polling/query ownership extracted before any required background lifecycle continues. | IDs/filters may be URL-backed; token stays memory-only. Existing destructive behavior remains unchanged. | Preserved legacy; no Recipe Console cutover. | `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts` — `tab=run-manager opens the legacy manager and returns with selected run context` | `/?workspace=black-box-runner&tab=run-manager` | `App.tsx`, `control-run-manager.ts`; 2026-07-10 |
| `legacy.distributed-recipes` | `DistributedRecipesPanel` plus preflight/monitor/compare/authoring; `tab=distributed-recipes` (aliases `distributed`, `distributed-runs`, `dist`) → advanced/distributed | Full legacy create/list/read/resolve/stage/start/cancel/export workflow, catalog/manifest/preflight, monitor/history/compare, diagnostics, and schema/AI prompt authoring. | `Advanced` fallback; capabilities migrate to `Execute`, `Monitor`, `Analyze`, and `Tune` | `src/legacy/runner/LegacyDistributedRecipesRoute.tsx`; new feature owners under `src/recipe-console/**`; canonical APIs in `control-run-manager.ts` | Selected-only under Advanced; compatibility pane guards mount by exact legacy tab. | Lazy/unmounted inactive after polling ownership moves to a service. | Selected run, filters, comparison, and timing metric become URL state; token and artifacts stay memory-only. | Iterations 4–8 qualify guided Execute, bounded Monitor, artifact Analyze, Tune/comparison, History/saved filters, and guarded retention. Canonical History browser acceptance now passes. Full diagnostics, schema/AI authoring, local execution, configured-live proof, and complete workflow parity remain pending, so this operational fallback stays visible, deep-linkable, uncut, and selected-only. | **Capability evidence passed:** canonical Monitor/Analyze/Tune/History/retention tests plus the preserved Advanced fallback. **Full row cutover still pending:** diagnostics, schema/AI-authoring, local-execution, and configured-live proof. | `/?workspace=black-box-runner&tab=distributed-recipes` | `src/recipe-console/{execute,monitor,analyze,tune,history}/**`, `src/legacy/runner/LegacyDistributedRecipesRoute.tsx`, `control-run-manager.ts`; `42eedae`, `47c332d`, `cc17169`, `382df72`, `fd9055e`; 2026-07-13 |
| `legacy.shared-test-catalog` | `SharedTestCatalogPanel`; `tab=shared-test` (aliases `artifacts`, `shared`, `shared-test-runner`) → advanced/shared-test | Browse browser-safe shared-test fixtures, capability/coverage ownership, recipe paths, and copyable runner commands. | `Advanced` | `src/legacy/runner/LegacySharedTestRoute.tsx` | Selected-only under Advanced, but a second hidden compatibility `SharedTestPanel` is always mounted. | One lazy/unmounted legacy route. | Catalog selection may be URL/personal state; no shell execution is introduced. | Preserved legacy; no cutover or new hide. | `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts` — `tab=shared-test opens the catalog and copies a runner command without executing a shell` | `/?workspace=black-box-runner&tab=shared-test` | `App.tsx`, `app-tabs.ts`, `current-state.md`; 2026-07-10 |
| `legacy.shared-test-import` | `SharedTestArtifactImportPanel`; `tab=shared-test` (aliases `artifacts`, `shared`, `shared-test-runner`) | Import and validate runner artifact bundles and project imported events, RTC diagnostics/messages, failure focus, summary, and replay recipe. | `Analyze` with `Advanced` fallback | `src/recipe-console/analyze/**` plus `src/legacy/runner/LegacySharedTestRoute.tsx` | Mounted with both Shared Test instances, including the always-mounted hidden compatibility instance. | Analyze importer is lazy/unmounted inactive; legacy fallback is one lazy route. | Large files stay in memory; profile/version warnings are visible and partial supported evidence remains usable. | Legacy import exists; no Recipe Console cutover. | `tests/playwright/rallar-black-box/recipe-console-analyze.spec.ts` — `imports a supported shared-test artifact offline and reports file-specific compatibility warnings` | `/?workspace=black-box-runner&tab=shared-test` | `App.tsx`, `current-state.md`; 2026-07-10 |
| `direct.quick-test` | `QuickRallarTestPanel`; `/?workspace=rallar&tab=quick-test`, aliases `quick`, `smoke` | Shortest real-data group create/join and room WS subscribe/send/wait/receive workflow; owns editable form values, the active subscription, received messages, current wait state, and sender/group/type/topic/context/resource evidence. | `Advanced` | `src/legacy/diagnostics/LegacyQuickTestRoute.tsx` | Mounted while hidden to retain editable values, subscription, received messages, and wait state; current blank-url fallback is this surface absent stored navigation. | Lazy/unmounted inactive only after those values and wait/message state are explicitly persisted or service-owned, or a deliberate reset contract is accepted; the subscription must be service-owned or closed. | **Temporary stateful exception:** editable values, active subscription, received messages, and wait state remain panel-owned. Do not unmount solely for the final default flip without satisfying the named state-preservation or reset proof. | Existing direct diagnostic; no Recipe Console cutover or new hide. | `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts` — `preserves Quick Test editable values received messages and wait state while service-owning the subscription across navigation`, or `applies the accepted Quick Test reset contract and closes the subscription before lazy unmount` | `/?workspace=rallar&tab=quick-test` | `App.tsx`, `app-tabs.ts`, `current-state.md`; 2026-07-10 |
| `direct.auth` | `LoginScreen`, `AuthCommandCenterPanel`; `/?workspace=rallar&tab=auth`, aliases `login`, `session` | Login/register/restore/logout/session clear, API/user/password drafts, ticket creation and current ticket state, action history, negative auth checks, TTL and redacted session evidence, plus the real-provider auth gate. | Shell infrastructure and `Advanced` | `src/recipe-console/app/auth/**`; diagnostic route `src/legacy/diagnostics/LegacyAuthRoute.tsx` | Auth panel is mounted while hidden to retain API/user/password drafts, ticket, and action history; the login gate replaces the app when required. | Auth provider/gate stays shared; the diagnostic panel may lazy-unmount only after non-secret API/history state is explicitly persisted or service-owned and reset of user/password/ticket state is accepted. | **Temporary stateful exception:** API/user/password drafts, current ticket, and action history remain panel-owned. User/password/ticket credentials and other secrets are never persisted; they must be service-owned ephemerally or reset on unmount. | Existing auth infrastructure; no Recipe Console cutover. | `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts` — `restores the Auth API draft and action history after lazy remount while resetting user password and ticket without persisting secrets`; `tests/playwright/rallar-black-box/recipe-console-shell.spec.ts` — `real provider preserves login restore and logout gates` | `/?workspace=rallar&tab=auth` | `App.tsx`, `runtime-store.ts`, `current-state.md`; 2026-07-10 |
| `direct.groups-clients` | Thin `RoomsClientsPanel`, focused controller/view/request/contracts/derivations under `src/legacy/diagnostics/rooms-clients/**`; `/?workspace=rallar&tab=rooms-clients`, aliases `rooms`, `groups`, `clients`, `people`, `presence` | Group/client/session/presence/state-event REST and direct-room actions, filters/sorts, membership assertions, cleanup, context promotion, diagnostics, and recipe snippets. | `Advanced` | `src/legacy/diagnostics/LegacyGroupsClientsRoute.tsx` | Mounted while hidden. | Lazy/unmounted inactive. | Filters/drafts require explicit personal persistence only if retained; live refresh ownership ends on unmount. | R2 complete surface extracted with exact parity; hidden-mounted lifetime retained; no cutover or new hide. | `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts` — `opens Groups Clients from a missing-member failure with group and agent context` | `/?workspace=rallar&tab=rooms-clients` | `RoomsClientsPanel.tsx`, `RoomsClientsView.tsx`, `use-rooms-clients-controller.ts`, `rooms-clients-request.ts`, contracts/derivations, `App.tsx`; 2026-07-11 |
| `direct.websocket` | `WebSocketCommandCenterPanel`; `/?workspace=rallar&tab=websocket`, aliases `ws`, `socket`, `websockets` | Rallar app WS send/subscribe/wait/receive, raw ticket/socket diagnostics, route/payload presets, reconnect/close, visible diagnostics, and recipe/parity export. | `Advanced` | `src/legacy/diagnostics/LegacyWebSocketRoute.tsx` | Mounted while hidden and can own subscription/socket state. | Lazy/unmounted inactive after socket/subscription lifecycle is service-owned or explicitly closed. | **Temporary stateful exception:** active subscription/socket and form values; never persist tickets. | Existing direct diagnostic; no cutover or new hide. | `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts` — `opens WebSocket from a ticket failure and releases the socket when leaving` | `/?workspace=rallar&tab=websocket` | `App.tsx`, `current-state.md`; 2026-07-10 |
| `direct.rtc-realtimes` | `RtcRealtimePanel`; `/?workspace=rallar&tab=rtc-realtime`, aliases `realtime`, `rtcrealtime` | Direct `realtime` and `messages.rtc` connect/send/subscribe/wait, lane health, received messages, timing phases, and runner-recipe export. | `Advanced` | `src/legacy/diagnostics/LegacyRtcRealtimeRoute.tsx` | Mounted while hidden and can own RTC subscriptions. | Lazy/unmounted inactive after connection/subscription ownership is explicit. | **Temporary stateful exception:** RTC connection/subscription and received evidence; secrets excluded. | Existing direct diagnostic; no cutover or new hide. | `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts` — `opens RTC Realtime with run context and closes view-owned subscriptions on exit` | `/?workspace=rallar&tab=rtc-realtime` | `App.tsx`, `current-state.md`; 2026-07-10 |
| `direct.topology` | `TopologyGraphPanel`; `/?workspace=rallar&tab=topology` | Derive/search/filter a graphology/Sigma topology, cap visible nodes, summarize routes, and select commands from runtime events. | `Advanced` | `src/legacy/diagnostics/LegacyTopologyRoute.tsx` | Mounted while hidden; receives an `active` flag to limit active rendering. | Lazy/unmounted inactive. | Search/node limit can be URL/personal state; renderer resources must dispose on exit. | Existing direct diagnostic; no cutover or new hide. | `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts` — `opens Topology with bounded nodes and disposes the renderer on return` | `/?workspace=rallar&tab=topology` | `App.tsx`, `current-state.md`; 2026-07-10 |
| `direct.rtc-diagnostics` | `RtcDiagnosticsPanel`, `FailurePanel`, `StatsPanel`; `/?workspace=rallar&tab=rtc-diagnostics`, aliases `rtc`, `diagnostics` | RTC phase/peer/lane/NACK/failure evidence, latency/timeseries/scatter/histogram/waterfall/agent matrix, stats, and copyable bundles. | `Advanced` with contextual links from `Monitor` | `src/legacy/diagnostics/LegacyRtcDiagnosticsRoute.tsx`; links owned by `src/recipe-console/advanced/**` | Mounted while hidden. | Lazy/unmounted inactive; deterministic evidence derivation remains shared. | Selected agent/command/transport use URL context; no hover-only evidence. | Existing direct diagnostic; no cutover or new hide. | `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts` — `opens RTC Diagnostics from a no-route failure with agent and command context` | `/?workspace=rallar&tab=rtc-diagnostics` | `App.tsx`, `current-state.md`; 2026-07-10 |
| `direct.rallar-data` | `RallarDataPanel`; `/?workspace=rallar&tab=rallar-data`, aliases `data`, `storage` | Scoped local store open/read/write/update/CAS/delete/export/usage, change events, and cleanup. | `Advanced` | `src/legacy/diagnostics/LegacyRallarDataRoute.tsx` | Mounted while hidden and owns store/change-listener references. | Lazy/unmounted inactive after listeners/stores are explicitly closed or service-owned. | **Temporary stateful exception:** open store and change subscription. Large exports are not persisted. | Existing direct diagnostic; no cutover or new hide. | `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts` — `opens Rallar Data and removes change listeners when leaving` | `/?workspace=rallar&tab=rallar-data` | `App.tsx`, `current-state.md`; 2026-07-10 |
| `direct.crdt` | Thin `CrdtHealthPanel` root with nested `CrdtEditorPanel`, focused controllers, board/entities views, and contracts under `src/legacy/diagnostics/crdt/**`; `/?workspace=rallar&tab=crdt-health`, aliases `crdt`, `collaboration` | Admin document health plus collaborative editor operations, transport selection, operation groups, and document/card/entity mutation evidence. | `Advanced` | `src/legacy/diagnostics/LegacyCrdtRoute.tsx` | Mounted while hidden; the nested editor is unconditionally mounted and owns its active document/subscription while the health controller retains admin state. | Lazy/unmounted inactive only after document/subscription cleanup and every retained editor/admin state has explicit persistence, service ownership, or an accepted reset contract. | **Temporary stateful exception:** active document/subscription, transient editor inputs/results, busy action, error, document list, selected document key, and last admin result remain view-owned. Authored CRDT data remains domain-owned and is not copied into URL/local defaults. | M1 complete surface extracted with exact parity; hidden-mounted lifetime retained; no cutover or new hide. | `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts` — `opens CRDT diagnostics and releases view-owned subscriptions on return` | `/?workspace=rallar&tab=crdt-health` | `CrdtHealthPanel.tsx`, `CrdtEditorView.tsx`, both controllers, board/entities views, contracts, `App.tsx`; 2026-07-11 |
| `direct.media` | `MediaConsolePanel`; `/?workspace=rallar&tab=media` | Local media attach, audio/video controls, policy application, remote-stream subscription/events, stop/cleanup, and diagnostics. | `Advanced` | `src/legacy/diagnostics/LegacyMediaRoute.tsx` | Mounted while hidden and can own streams/subscriptions. | Lazy/unmounted inactive with mandatory stream/subscription cleanup. | **Temporary stateful exception:** active media streams and remote subscription; no media payload persistence. | Existing direct diagnostic; no cutover or new hide. | `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts` — `stops media tracks and remote subscriptions when leaving Media` | `/?workspace=rallar&tab=media` | `App.tsx`, `current-state.md`; 2026-07-10 |
| `direct.rallar-server` | Thin `RallarServerPanel`, focused controller/view/feedback/parsing/contracts under `src/legacy/diagnostics/rallar-server/**`; `/?workspace=rallar&tab=rallar-server`, alias `server` | Authenticated API-v1 presets/OpenAPI refresh, raw request/response lifecycle, auth injection, redacted cURL/command export, context promotion, persisted collection/variables/request drafts, assertions, extraction, and recipe export. | `Advanced` | `src/legacy/diagnostics/LegacyRallarServerRoute.tsx` | Mounted while hidden to preserve drafts, invalid editable JSON, presets, feedback, responses/results, and busy/error state. | Lazy/unmounted inactive after every retained state owner has explicit persistence, service ownership, or an accepted reset contract. | **Temporary stateful exception:** request/collection drafts persist redacted forms; invalid JSON, presets, feedback, response/collection results, and busy/error state remain view-owned. Credentials and response/artifact bulk remain excluded from persistence. | M1 complete surface extracted with exact parity; hidden-mounted lifetime retained; no cutover or new hide. | `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts` — `restores redacted Rallar Server drafts without credentials after an Advanced round trip` | `/?workspace=rallar&tab=rallar-server` | `RallarServerPanel.tsx`, `RallarServerView.tsx`, `use-rallar-server-controller.ts`, feedback/parsing/contracts, `App.tsx`; 2026-07-11 |
| `direct.rallar-trace` | `RallarTracePanel` plus `RallarBrowserTraceBar`; `/?workspace=rallar&tab=rallar-trace`, aliases `trace`, `rallartrace` | Always-visible signaling/RTC/group/peer/latest-event strip and full redacted browser-runtime event/failure drill-in with source and severity filters plus an editable event limit. | Shell infrastructure plus `Advanced` | `src/recipe-console/app/**` for compact status; `src/legacy/diagnostics/LegacyTraceRoute.tsx` for full trace | Trace strip always mounted; full panel mounted while hidden and retains its source filter, severity filter, and event limit. | Compact service-fed shell status stays mounted; full trace becomes lazy/unmounted inactive after its filters and event limit move to URL/personal-default persistence. | **Temporary stateful exception:** source/severity filters and event limit are currently panel-owned mounted state. Runtime events remain service-owned and bounded; selected trace context may use URL state. | Existing infrastructure/diagnostic; no cutover or new hide. | `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts` — `restores Rallar Trace source severity filters and event limit after lazy remount and returns to the selected run` | `/?workspace=rallar&tab=rallar-trace` | `App.tsx`, `current-state.md`; 2026-07-10 |
| `diagnostic.event-stream` | `ExecutionFocusPanel`, `CommandHistoryPanel`, `StatsPanel`, `FailurePanel`, `EventStreamPanel`; `/?workspace=rallar&tab=event-stream` or `/?workspace=black-box-runner&tab=event-stream`, aliases `events`, `event` | Selected execution focus, command history, stats, failure list, kind/transport/text filtering, and bounded 40/100/250/500 event windows. | `Monitor` evidence plus `Advanced` full stream | `src/recipe-console/monitor/**` for contextual evidence; `src/legacy/diagnostics/LegacyEventStreamRoute.tsx` for full stream | Mounted while hidden in both workspace modes; filters and selected command survive navigation/reload. | Lazy/unmounted full stream after filters/selection move to URL/personal defaults; event collection is service-owned and bounded. | **Temporary stateful exception:** filter/selection persistence and runtime subscription ownership. No large raw stream persistence. | Existing shared tab; no Recipe Console cutover or new hide. | `tests/playwright/rallar-black-box/recipe-console-monitor.spec.ts` — `opens all available correlated evidence from a failure row`; `bounds rendered secondary Monitor events and reports the exact omission count`; `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts` — `restores Event Stream filters and leaves no inactive polling` | `/?workspace=black-box-runner&tab=event-stream` (direct fallback: `/?workspace=rallar&tab=event-stream`) | `src/recipe-console/monitor/**`, `App.tsx`, `app-tabs.ts`; `42eedae`; 2026-07-12 |

## Cutover rule

A row may move from baseline/preserved to cut over only after its exact proof passes, its rollback URL remains verified, its state owner is explicit, and inactive legacy effects are absent or covered by a still-current documented exception. Navigation consolidation alone is never cutover evidence.
