# Rallar Recipe Console Fleet And Geographic Evidence Implementation Plan

Status: complete; Tasks 0–8 and every Iteration 10 exit criterion are
code-backed through `0088be0` and `3ab86a9`

**Goal:** Replace the Recipe Console Fleet placeholder with a lean, bounded,
live/last-known evidence workspace that answers which agents or regions fail
repeatedly, whether timing is implicated, and which exact run and artifact
support the conclusion, without turning Recipe Console into a map application.

**Architecture:** Keep the already-extracted legacy Fleet behavior, import
paths, active-only mount, and UI unchanged as the operational fallback while
thin compatibility adapters converge its deterministic helpers on shared-test.
Add tolerant wire validation plus deterministic report and geographic analysis
under `packages/shared-test/rallar-bb-test/**`.
The new lazy `src/recipe-console/fleet/**` route consumes the existing root
control query and indexed control selection, derives no second polling or
credential owner, uses explicit bounded windows for variable-height evidence,
and renders its deterministic SVG map as secondary evidence. New React and CSS
remain feature-local; shared-test remains React-free.

## Repository-Authoritative Plan Correction

The parent plan names `src/legacy/runner/LegacyFleetRoute.tsx` as a first
extraction step. Repository history and exact structure gates show that the
stronger behavior-preserving extraction already landed at `9e5b4b5`:
`RunnerFleetPanel`, `useRunnerFleetController`, pure helpers, and five
controlled views live under `src/legacy/runner/fleet/**`; `App.tsx` owns none of
their behavior; and the panel mounts only while the legacy Fleet tab is active.
`RunnerWorkspaceTabPanels.tsx` is deliberately fingerprint-locked to import
that feature root directly. Iteration 10 records this as the completed legacy
extraction and will not add a filename-only wrapper that weakens those proven
invariants.

## Binding Decisions

- The exact capability owner is
  `tests/playwright/rallar-black-box/recipe-console-fleet.spec.ts` —
  `restores fleet filters and map layers and links a failure signature to its run evidence`.
- Old Fleet URLs remain legacy and operational:
  `/?workspace=black-box-runner&tab=fleet`, `tab=fleet-report`, and
  `tab=fleet-reports`. The new route is
  `?v=1&experience=recipe-console&view=fleet`. Iteration 10 hides no legacy row
  and changes no default, alias, rollback URL, or cutover state.
- The new workspace is a lazy Recipe Console feature chunk and is unmounted
  while inactive. It must not import `src/legacy/**`, the legacy Fleet panel,
  legacy global styles, or a compatibility barrel around them.
- `ControlConnectionProvider` remains the only Recipe Console control poll and
  credential owner. Fleet consumes its current/last-known root snapshot,
  `fleetReports`, and already-derived indexed `selection.boardRows`; it does
  not copy the legacy control URL/token form, initial fetch effect, or polling
  loop.
- Existing `/fleet/reports`, rebuild, single-report, and bundle endpoints are
  sufficient. No control-server endpoint, request, response, OpenAPI schema,
  artifact profile, or required file changes. Rebuild remains in the preserved
  legacy fallback. Add one narrow authorized lazy capability for an explicit
  selected-report bundle read/export; it delegates the existing client,
  validates and bounds the response, retains at most one bundle in active Fleet
  memory, and never polls.
- The selected bundle must contain only the four contract file keys, match the
  requested `distributedRunId`, remain at or below 16 MiB UTF-8 per file and
  48 MiB aggregate, and preserve file text exactly. Oversize or malformed
  bundles never replace the last usable selected artifact.
- Add a backward-compatible `fetchFleetReportBundleBytes(...)` client function
  with a required 64 MiB transfer ceiling. It rejects an oversized declared
  length before allocation, incrementally bounds chunked bodies, caps error
  bodies at the existing 64 KiB policy, and reuses the current bounded control-
  artifact reader. Parse and per-file validation happen only after this transfer
  gate; the existing typed `fetchFleetReportBundle(...)` export is unchanged.
- Add uniquely named shared modules and exports without changing or removing
  `fleet-report.ts`, the indirect `control-snapshots.ts` exports, or
  `control-run-manager.ts` re-exports. Do not broadly re-export
  `fleet-report.ts` from `mod.ts`, because overlapping names are already
  exported through `control-snapshots.ts`.
- Fleet report validation is tolerant and additive: accept schema-v1 known
  fields plus unknown extensions, preserve legacy labels that omit inner
  `label.agentId`, reject malformed required structures/coordinates, report
  unsupported versions, and retain every valid non-conflicting report beside
  visible issues.
  A malformed optional report must not crash or erase otherwise usable live
  board evidence.
- A duplicated `distributedRunId` quarantines every report with that identity;
  there is no ambiguous winner. Accepted reports and duplicate issues are
  permutation-invariant. Validation exposes exact source/accepted/quarantined
  counts, retains at most 64 stable issues, and reports the exact omitted-issue
  count.
- Canonical report order is `generatedAtEpochMs` descending, then exact
  `distributedRunId`. Labels call this report-generation time; rebuilding can
  refresh it, so it is not presented as run-occurrence time.
- Shared aggregation groups only by persisted `signatureId`, unions and sorts
  affected agents/regions/runs, preserves min/max observation times, treats
  `timed-out` as failed, ignores non-finite durations, and uses the current
  nearest-rank percentile rule. Inputs and nested reports are never mutated.
- Heatmap lookup is indexed once. The active heatmap mounts at most 32 agent
  rows by 8 run columns; live agents mount at most 40 rows; regions, failures,
  and timing groups mount at most 24 rows apiece. Explicit Previous/Next
  windows expose exact ranges and complete traversal; closed disclosures are
  unmounted.
- A synthetic multi-report/multi-agent owner records report/outcome/index/cell
  lookup counters and proves one-pass indexing with no per-cell report scan.
  Validation issues, agent details, and report details are also explicitly
  bounded with exact omitted counts.
- `fleetRegion` and `fleetMapLayers` remain the only Fleet-specific v1 URL
  fields. Undefined layer state means all four canonical layers are enabled;
  an empty array serializes as `none`. Committed region and layer changes use
  `navigate` and push history; `replace` is reserved for canonicalization or
  unavailable-selection cleanup. Never mutate browser history directly.
- `artifactRefs` are opaque evidence identifiers, not URLs. Run/agent/history/
  artifact handoffs use typed `controlRunId`, `distributedRunId`, `agentId`,
  supported failure category, and exact Recipe Console navigation patches.
  The selected report inspector displays/copies the opaque references as
  identifiers and retrieves actual Fleet artifact files only through the
  narrow selected-report bundle capability.
- Geography precedence is explicit agent coordinates, documented datacenter
  lookup, documented region lookup, otherwise unresolved. Every resolved
  location carries source and precision. Routes appear only from explicit
  target-agent fields in control events and only when both endpoints resolve;
  peer/session text is never geocoded or inferred.
- Route evidence is explicitly an observation from the root control snapshot's
  bounded event window, not a complete network topology. The UI states that
  source limitation and never invents an omitted-route total the server does
  not provide.
- Live and historical evidence remain separate layers. Live evidence owns
  current connection/status/identity. Map location precedence for the same
  agent is live explicit coordinates, newest historical explicit coordinates,
  documented live datacenter/region lookup, newest documented historical
  lookup, then unresolved. Historical pass/fail/missing outcomes never replace
  current live state; repeated historical failures remain visibly historical.
- The SVG mounts at most 40 agent markers, 24 region markers, 32 route paths,
  and 40 failure marks using stable severity/recency/ID order with a valid
  selection pinned. It reports candidate/rendered/omitted counts; persistent
  windowed HTML evidence traverses every item omitted from the secondary map.
- The map is secondary to persistent HTML evidence. Its SVG has a visible text
  summary and equivalent keyboard-operable HTML region/agent controls; no
  conclusion or action depends on hover, color, or an interactive SVG child.
- New UI uses Direction A tokens and focused CSS Modules under
  `src/recipe-console/fleet/**`. It introduces no broad selector, global style,
  registry, or `RecipeConsoleWorkspace`/`RecipeConsoleActiveWork` monolith.
- Deterministic desktop, touch-portrait, touch-landscape, and degraded-state
  screenshots are reviewed against Direction A and recorded in the fidelity
  ledger; responsive assertions alone are not visual acceptance.
- A barrel-import public-surface test imports every new shared API from
  `rallar-bb-test/mod.ts`. Direct `deno check` covers the three new shared
  modules because the package's existing Deno entry list does not traverse
  them automatically.
- Configured-live/Postgres remains unavailable unless the documented stack is
  present. Its exact skip reason is never represented as a pass.

## Task 0: Freeze Existing Ownership, Baseline, And Exit Contract

- [x] Audit current legacy extraction, active-only mount, aliases, root query,
  shared types, app-local derivations, map provenance, URL codec, CSS, and test
  owners against repository behavior.
- [x] Record the `LegacyFleetRoute.tsx` plan correction and bind the new
  canonical acceptance title, window budgets, URL fields, evidence handoffs,
  and no-cutover rule before code changes.
- [x] GREEN the existing Fleet/map/URL/structure unit baseline and exact legacy
  Fleet browser baseline at a clean head.
- [x] Record sandbox/unavailable evidence exactly rather than treating it as a
  product pass or failure.

### Task 0 baseline — `7d25ab9`

The focused unit baseline passes 74/74 tests across legacy Fleet analysis,
world-map provenance/routes, Recipe Console URL state, and exact app structure.
The initial Playwright attempt could not bind `127.0.0.1:5176` in the sandbox
and is unavailable evidence. The identical authorized local-server rerun passes
3/3 legacy Fleet cases: the 20-agent report/heatmap/failure/timing/export flow,
map-layer URL restoration, and 390×800 mobile operation. No source changed.

## Task 1: Add Tolerant Shared Fleet Report Validation

- [x] RED `rallar-bb-test-fleet-report-validation.test.ts` for valid responses,
  valid single reports and bundles, unknown-field tolerance, legacy labels
  without inner `agentId`, mixed valid/malformed arrays, unsupported versions,
  duplicate run identities, invalid coordinates, malformed required
  collections, wrong bundle identity/files, and UTF-8 file/aggregate limits.
- [x] Add `fleet-report-validation.ts` with the bound 64-issue budget, exact
  omitted count, and all-duplicates-quarantined policy. Prove input permutation
  cannot choose a different report or issue order; retain exact source/
  accepted/quarantined cardinality without mutating input.
- [x] Use the validator at the Recipe Console Fleet boundary only; do not make
  the optional collection a fatal root-query error or change existing server
  response semantics.
- [x] RED then GREEN `rallar-bb-test-fleet-public-surface.test.ts` importing the
  new APIs only from `mod.ts`; GREEN shared TypeScript and direct Deno checks of
  every new Fleet module.

Validation:

```bash
npx vitest run packages/tests/shared-test/rallar-bb-test-fleet-report-validation.test.ts
npx vitest run packages/tests/shared-test/rallar-bb-test-fleet-public-surface.test.ts
npm --workspace @ar-eye-hunter/shared-test run check:ts
deno check packages/shared-test/rallar-bb-test/fleet-report-validation.ts
```

## Task 2: Move Deterministic Fleet Report Analysis To Shared Test

- [x] RED `rallar-bb-test-fleet-report-analysis.test.ts` for shuffled-input
  determinism, stable tie-breaks, no mutation, all agent states, indexed
  heatmap joins/missing cells, regional aggregation, repeated signatures,
  exact affected evidence, nearest-rank timing, missing labels, and bounded
  agent/run detail.
- [x] Add a synthetic multi-report/multi-agent case with exact optional work
  counters for report/outcome visits, index inserts, and cell lookups. Prove
  linear source indexing, no per-cell `.find`, and bounded issue/detail output.
- [x] Add `fleet-report-analysis.ts` with focused public functions and a small
  composed report-analysis model. Make every display/detail limit explicit.
- [x] Preserve the characterized legacy semantics through differential parity
  fixtures, including first/newest report authority, timing results, failure
  aggregation, and exact identifiers. Then turn the old derivation/rollup/
  timing files into thin compatibility adapters over shared-test and replace
  historical implementation fingerprints with exact delegation plus output-
  parity locks; preserve every legacy import path and export.
- [x] Export only the new uniquely named analysis module from `mod.ts`.

Validation:

```bash
npx vitest run \
  packages/tests/shared-test/rallar-bb-test-fleet-report-analysis.test.ts \
  packages/tests/rallar-black-box/fleet-analysis.test.ts \
  packages/tests/rallar-black-box/app-structure.test.ts
npm --workspace @ar-eye-hunter/shared-test run check:ts
deno check packages/shared-test/rallar-bb-test/fleet-report-analysis.ts
```

## Task 3: Add Provenance-Bearing Shared Geographic Evidence

- [x] RED `rallar-bb-test-fleet-geography.test.ts` for explicit-coordinate,
  documented-datacenter, documented-region, and unresolved precedence; live
  versus historical field authority; separate live/historical states; stable
  regional evidence; explicit route aggregation; unresolved endpoints; failed
  counts; and peer-ID non-inference.
- [x] Add `fleet-geography.ts` with React-free location, region, agent, route,
  and summary evidence. Keep SVG projection and rendering app-local.
- [x] Extract route evidence only from documented explicit target-agent event
  fields. Require both endpoints to have evidence-backed coordinates.
- [x] Make legacy location/route helpers thin compatibility delegates to the
  shared primitives and differentially prove existing world-map rules. The
  new shared combined model intentionally keeps current live status separate
  from historical outcome rather than inheriting the legacy stale-state merge.
  Preserve every legacy public/import surface.

Validation:

```bash
npx vitest run \
  packages/tests/shared-test/rallar-bb-test-fleet-geography.test.ts \
  packages/tests/rallar-black-box/world-map-model.test.ts
npm --workspace @ar-eye-hunter/shared-test run check:ts
deno check packages/shared-test/rallar-bb-test/fleet-geography.ts
```

## Task 4: Define The Fleet Workspace State And Handoff Contract

- [x] RED `recipe-console-control-fleet-api.test.ts` for lazy load, existing
  endpoint delegation, authorized retry, abort/current-generation rejection,
  selected-report identity validation, per-file/aggregate size bounds, one-
  bundle retention, explicit clear, and no background request. RED the additive
  bytes client for declared-length and chunked overflow cancellation, bounded
  error bodies, exact bytes, HTTP errors, and the unchanged typed client.
- [x] Add a narrow `control-fleet-api.ts` lazy capability to the existing
  control connection. It reads only an explicitly requested report bundle and
  changes no endpoint or credential contract; rebuild/list remain legacy-owned.
- [x] RED `recipe-console-fleet-model.test.ts` for connecting, live, partial,
  stale, offline, empty, mixed-valid/schema-error, selected-region, selected-
  run, and selected-agent states using the root query and indexed selection.
- [x] RED `recipe-console-fleet-handoff.test.ts` for exact Monitor, Analyze,
  Tune/History, and affected-agent URL patches; incompatible fields clear only
  where required and Fleet URL state survives a return trip.
- [x] Add small pure `fleet-workspace-model.ts`, `fleet-url-patches.ts`, and
  feature-local adapters from `selection.boardRows` to shared live evidence.
- [x] Preserve last-known reports in stale state, distinguish absent optional
  collection from an empty collection, and expose validation issues without
  suppressing valid evidence.
- [x] Do not add a feature poll, token field, endpoint duplicate, global store,
  or hidden retained component tree.

Validation:

```bash
npx vitest run \
  packages/tests/rallar-black-box/control-run-manager.test.ts \
  packages/tests/rallar-black-box/recipe-console-control-fleet-api.test.ts \
  packages/tests/rallar-black-box/recipe-console-fleet-model.test.ts \
  packages/tests/rallar-black-box/recipe-console-fleet-handoff.test.ts \
  packages/tests/rallar-black-box/recipe-console-url-state.test.ts
```

### Tasks 1–4 evidence — `0d046ca`

The shared boundary now validates tolerant schema-v1 report collections and
the exact four-file bundle, quarantines all duplicate identities, preserves
unknown extensions, rejects non-finite wire numbers, and enforces the 64-issue,
16 MiB per-file, and 48 MiB aggregate limits. The additive bytes client bounds
declared and streamed responses at 64 MiB before the lazy authorized Fleet
capability parses or retains one explicitly selected bundle.

Shared report analysis, provenance-bearing geography, and the legacy
compatibility adapters are deterministic and React-free. Exact legacy input,
timed-out, tie, and locale behavior remains explicit. Region, timing, and route
identities are collision-safe even when operator labels contain display
separators; human labels and normal legacy output remain stable. Route evidence
still requires explicit target-agent fields and two resolved endpoints.

The pure Fleet workspace boundary distinguishes absent, empty, mixed-schema,
partial, stale, offline, and live evidence; preserves exact run/control/agent
selections; and defers unavailable cleanup truth until current, complete,
present, fully valid owning evidence exists. History handoff uses the exact
searchable distributed-run identity plus group/recipe and clears the Fleet
failure category because Fleet and History category derivations are not
equivalent for every runtime/diagnostic failure.

The stable milestone gate passes 267/267 tests across 15 owner files, shared
and app TypeScript, direct Deno checks of all three new shared modules, and
`git diff --check`. Two independent final re-audits are clean after RED/GREEN
fixes for non-finite values, locale parity, exhaustive barrel exports, exact
selection authority, History filtering, and tuple-safe public identities.
No endpoint, existing typed client, public legacy import, default, navigation
row, rollback URL, legacy mount policy, or cutover changed.

At this milestone, Task 5 review found one repository-authoritative
prerequisite: the current
composed analysis exposes only its first bounded rows and the workspace model
performs a second region index. Before rendering, add one reusable shared
indexed collection plus complete bounded window projection so first/middle/
final traversal is possible without re-indexing or app-local aggregation.

## Task 5: Replace The Placeholder With A Lazy, Bounded Fleet Workspace

- [x] RED `recipe-console-fleet-structure.test.ts` for the lazy boundary,
  active-only composition, no legacy imports, no second query/poll, CSS Module
  ownership, line caps, and focused module DAG.
- [x] RED `recipe-console-fleet-ui.test.ts` for semantic headings, operational
  state panels, exact counts/ranges, complete windows, selected evidence, and
  keyboard-operable actions.
- [x] Replace the eager `FleetPreview` branch with lazy `FleetWorkspace` input
  wiring from `RecipeConsoleWorkspace`; keep `RecipeConsoleActiveWork` and the
  workspace as routing/composition glue only.
- [x] Compose focused live-board, summary, heatmap, region, repeated-failure,
  timing, and evidence-detail components under `src/recipe-console/fleet/**`.
- [x] Reuse `ExplicitWindowControls`/window state and native lists/tables.
  Slice before per-row/cell projection and expose exact `Showing a–b of n`
  truth; no native select is silently truncated.
- [x] Render complete empty/loading/partial/stale/offline/schema-error states
  and retain visible refresh/legacy-fallback paths.

Validation:

```bash
npx vitest run \
  packages/tests/rallar-black-box/recipe-console-fleet-structure.test.ts \
  packages/tests/rallar-black-box/recipe-console-fleet-ui.test.ts \
  packages/tests/rallar-black-box/recipe-console-structure.test.ts
npm --workspace rallar-black-box run typecheck
```

## Task 6: Add The Secondary Map And Exact Evidence Links

- [x] RED map component tests for layer semantics, visible provenance,
  unresolved truth, selected region/agent, keyboard-equivalent HTML controls,
  no-route state, explicit route evidence, stable selected-item pinning, exact
  candidate/rendered/omitted counts, and the 40-agent/24-region/32-route/
  40-failure-mark DOM budgets.
- [x] Add a deterministic feature-local SVG map and CSS Module. Keep it below
  summary/failure evidence and pair every color/shape with persistent text.
- [x] Wire region selection to `fleetRegion`, layer toggles to canonical
  `fleetMapLayers`, affected agents to `agentId`, exact runs to Monitor/Analyze,
  and repeated signatures to filtered Tune/History without treating opaque
  artifact refs as URLs.
- [x] Add an explicit selected-report artifact action that loads the validated
  existing Fleet report bundle, shows exact file identities/sizes, and exports
  it without retaining multiple bundles or issuing an inactive request.
- [x] Preserve exact selected report/control identities and never silently
  substitute a different run when a URL selection is unavailable.
- [x] Expose the legacy Fleet fallback for rebuild/report export; do not hide
  the legacy row after this capability proof.

Validation:

```bash
npx vitest run \
  packages/tests/rallar-black-box/recipe-console-fleet-ui.test.ts \
  packages/tests/rallar-black-box/recipe-console-fleet-handoff.test.ts \
  packages/tests/shared-test/rallar-bb-test-fleet-geography.test.ts
```

## Task 7: Prove Browser Behavior, Responsiveness, And CSS Isolation

- [x] RED then GREEN the exact canonical browser title with seeded root-query
  evidence and no legacy component import.
- [x] Cover desktop 1440×900, tablet 900×900, genuine-touch portrait 430×932,
  and genuine-touch landscape 932×430 with zero document overflow and bounded
  internal scrolling.
- [x] Cover keyboard-only navigation, 44px touch targets, focus recovery after
  region/window changes, reduced motion, non-hover evidence, long/bidi IDs,
  all operational states, first/middle/last window traversal, and exact map DOM
  budgets plus omission truth under a pressured fixture.
- [x] Cover `fleetRegion`/`fleetMapLayers` copy/reload/back-forward restoration,
  including every intermediate state across multiple committed changes; exact
  failure-to-agent/run/History/Analyze handoffs; selected-report artifact load/
  export; unresolved geography; and explicit-route-only rendering.
- [x] Capture and review deterministic Direction A desktop, touch portrait,
  touch landscape, and degraded operational-state screenshots; update only the
  approved Fleet baselines and record their evidence in the fidelity ledger.
- [x] Prove both CSS load orders, cold Recipe Console versus legacy-first Fleet,
  inactive unmount/cleanup, Fleet chunk separation, and exact `tab=fleet`,
  `tab=fleet-report`, and `tab=fleet-reports` legacy selection/mount without a
  Recipe Console redirect.

Validation:

```bash
npx playwright test \
  --config apps/rallar-black-box/playwright.recipe-console.config.ts \
  tests/playwright/rallar-black-box/recipe-console-fleet.spec.ts \
  tests/playwright/rallar-black-box/recipe-console-fleet-visual.spec.ts

npx playwright test \
  --config apps/rallar-black-box/playwright.recipe-console.config.ts \
  tests/playwright/rallar-black-box/recipe-console-shell.spec.ts \
  tests/playwright/rallar-black-box/recipe-console-history.spec.ts \
  tests/playwright/rallar-black-box/recipe-console-status-semantics.spec.ts \
  tests/playwright/rallar-black-box/recipe-console-responsive-accessibility.spec.ts \
  tests/playwright/rallar-black-box/recipe-console-css-isolation.spec.ts \
  tests/playwright/rallar-black-box/recipe-console-chunks.spec.ts

npx playwright test \
  --config apps/rallar-black-box/playwright.config.ts \
  tests/playwright/rallar-black-box/fleet-reporting.spec.ts \
  tests/playwright/rallar-black-box/tabbed-navigation.spec.ts
```

## Task 8: Independent Reviews And Fresh Iteration Exit

- [x] Dispatch independent shared validation/analysis, geographic evidence,
  React/state/accessibility, and strangler/cutover reviews. RED/GREEN every
  Critical or Important finding and rerun its owner.
- [x] Run all focused shared/app tests above, complete app Vitest, shared/app
  TypeScript and all shared Deno entries, app build, reciprocal experience-
  chunk assertion, complete Recipe Console browser config, and preserved
  legacy Fleet/navigation cases.
- [x] Run control-server check/tests only if shared changes affect its imports
  or server source changes; otherwise record the untouched contract evidence.
- [x] Try the in-app Browser and record exact availability. Report configured-
  live/Postgres as skipped with the exact unavailable-environment reason; never
  treat it as passed.
- [x] Update this child plan, parent iteration ledger/risks, product spec,
  migration register, and fidelity ledger with commits, test counts, viewport/
  interaction/CSS proof, skip reasons, no-cutover state, and remaining
  Iterations 11–12 risks.
- [x] Make cohesive local green milestone commits. Do not push or open a PR.

### Tasks 5–8 qualified exit — `0088be0`, `3ab86a9`

`0088be0` replaces the placeholder with a lazy, active-only Fleet workspace
whose live board, heatmap, region, failure, timing, map, report, and artifact
evidence use complete bounded windows over shared indexed truth. The map stays
secondary, every route and location remains provenance-bearing, current live
state stays separate from historical outcomes, and exact agent/run/History/
Analyze handoffs preserve typed URL context. The workspace adds no poll,
credential owner, legacy import, global registry, broad stylesheet, endpoint,
or required artifact file.

`3ab86a9` adds the canonical seven-case Fleet browser owner and five reviewed
Direction A baselines. Desktop, tablet, genuine-touch portrait and landscape,
keyboard/focus, 44px targets, reduced motion, long/bidi evidence, operational
states, copy/reload/back-forward, exact handoffs, artifact load/export,
bounded traversal, map budgets, zero document overflow, CSS load order,
inactive cleanup, chunk separation, and all three legacy Fleet aliases pass.
The five no-update baselines pass 3/3 and have SHA-256 values recorded in the
fidelity ledger.

Fresh qualification passed the 18-file focused contract at 279/279, shared
TypeScript and configured Deno checks, direct Deno checks of all three Fleet
modules, app TypeScript, and a 758-module production build. The Fleet asset is
62.26 kB JavaScript (15.98 kB gzip) and 22.76 kB CSS (3.90 kB gzip); reciprocal
experience-chunk closure passes, with only the pre-existing greater-than-500-kB
`LegacyExperience` advisory. The complete app suite passes 1,472/1,472 across
139 files. Browser qualification passes Fleet 7/7, visual no-update 3/3, the
broader Recipe Console regression matrix 65/65, the complete Recipe Console
configuration with 179 passed and one exact configured-live skip, legacy
Fleet/navigation 33/33, and existing-owner regressions 28/28. Independent
shared-analysis, geography,
React/state/accessibility, browser, and strangler reviews are clean after
focused RED/GREEN repairs.

The in-app Browser was unavailable exactly as `Browser runtime unavailable
after setup failure: Cannot redefine property: process`; terminal Playwright
is the fallback, not an in-app Browser pass. The configured live/Postgres owner
remains skipped, not passed, for exactly: `Set RALLAR_BLACK_BOX_FULL_STACK=1
with Postgres-backed apps/api-v1, apps/rallar-black-box-control-server, and
apps/rallar-black-box available.` Control-server source and contracts were
unchanged. No legacy Fleet row, alias, active-only mount, rebuild/export path,
rollback URL, default, public export, or existing control contract was hidden,
cut over, or broken. Remaining work is Iterations 11–12: contextual Advanced
diagnostics, safe lazy legacy ownership, the default flip, and final cross-app
accessibility polish.

## Iteration 10 Exit Criteria

- [x] A user can identify repeatedly failing agents and regions, see whether
  timing is correlated, and reach the exact affected run/agent/artifact/history
  evidence from visible controls.
- [x] Live board, heatmap, region summaries, repeated failure signatures,
  timing distributions, and the deterministic SVG map derive from validated
  shared evidence and remain bounded/traversable.
- [x] Geography and routes are provenance-bearing and never guessed; unresolved
  locations and unavailable optional collections remain explicit.
- [x] Fleet URL filters and map layers restore exactly across copy, reload, and
  browser history.
- [x] The new route is lazy/unmounted, CSS-isolated, responsive, keyboard/touch
  operable, reduced-motion safe, and free of hover-only evidence.
- [x] The legacy Fleet row, behavior, aliases, active-only mount, rebuild,
  export, public contracts, and rollback URL remain operational. No default or
  cutover changes.
- [x] Every available focused, complete, build, chunk, browser, and review gate
  is green; unavailable live-service evidence is recorded as skipped with its
  exact reason.

## Focused Validation Contract

```bash
npx vitest run \
  packages/tests/shared-test/rallar-bb-test-fleet-report-validation.test.ts \
  packages/tests/shared-test/rallar-bb-test-fleet-report-analysis.test.ts \
  packages/tests/shared-test/rallar-bb-test-fleet-geography.test.ts \
  packages/tests/shared-test/rallar-bb-test-fleet-public-surface.test.ts \
  packages/tests/rallar-black-box/fleet-analysis.test.ts \
  packages/tests/rallar-black-box/world-map-model.test.ts \
  packages/tests/rallar-black-box/control-run-manager.test.ts \
  packages/tests/rallar-black-box/recipe-console-control-fleet-api.test.ts \
  packages/tests/rallar-black-box/recipe-console-fleet-model.test.ts \
  packages/tests/rallar-black-box/recipe-console-fleet-handoff.test.ts \
  packages/tests/rallar-black-box/recipe-console-fleet-structure.test.ts \
  packages/tests/rallar-black-box/recipe-console-fleet-ui.test.ts \
  packages/tests/rallar-black-box/recipe-console-url-state.test.ts \
  packages/tests/rallar-black-box/recipe-console-structure.test.ts \
  packages/tests/rallar-black-box/app-structure.test.ts \
  packages/tests/rallar-black-box/legacy-shell-composition.test.ts \
  packages/tests/rallar-black-box/app-tabs.test.ts \
  packages/tests/rallar-black-box/experience-route.test.ts

npm --workspace @ar-eye-hunter/shared-test run check:ts
npm --workspace @ar-eye-hunter/shared-test run check:deno
deno check \
  packages/shared-test/rallar-bb-test/fleet-report-validation.ts \
  packages/shared-test/rallar-bb-test/fleet-report-analysis.ts \
  packages/shared-test/rallar-bb-test/fleet-geography.ts
npm --workspace rallar-black-box run typecheck
npm --workspace rallar-black-box run build
npx tsx apps/rallar-black-box/scripts/assert-experience-chunks.ts
```

Configured-live exact skip when the stack is unavailable:

`Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
apps/rallar-black-box-control-server, and apps/rallar-black-box available.`
