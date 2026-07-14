# Rallar Black Box SPA Reimplementation Plan

Date: 2026-07-06
Last reviewed: 2026-07-12

## Goal

Reimplement `apps/rallar-black-box` as a lean operator SPA for distributed recipe execution and analysis. The finished SPA should let a user:

- choose a recipe and target browser agents safely
- stage, start, cancel, and monitor distributed runs
- see pass/fail status without reading raw JSON
- diagnose failed runs from correlated evidence
- compare runs and tune recipe timing, especially RTC stream cadence, drift, latency, drops, and backpressure
- import/export artifact bundles for CI, bug reports, and offline analysis

This is not a plan for a generic Rallar admin console. Direct Auth, Groups, WS, RTC, Data, CRDT, Media, REST, and manual workbench tools remain useful, but they should become supporting diagnostics or advanced tools instead of the main product surface.

## Pre-migration Baseline Findings

At the 2026-07-06 baseline, the existing SPA was capable but too broad for the
distributed-recipe job:

- `apps/rallar-black-box/src/App.tsx` is 28,265 lines and owns shell, fetching, execution, monitoring, artifact import, recipe authoring, fleet views, direct Rallar tools, and many forms in one file.
- `apps/rallar-black-box/src/styles.css` is 7,380 lines, so a new look and feel should not be achieved by layering more global selectors onto the existing CSS. The rewrite needs an isolated design system and stylesheet boundary.
- The file currently declares 78 top-level capitalized component functions and contains 359 `useState`/`useEffect`/`useMemo`/`useCallback` calls. Even though the final `App()` composition is only the bottom part of the file, component ownership, state ownership, and bug fixes are still coupled by the single module.
- Several top-level tab panels use `hidden` while their component trees remain mounted. That is useful for a few draft-heavy tools, but it is not a good default strangler mechanism because hidden effects, polling, memory, and static imports still count toward runtime and bundle cost.
- `apps/rallar-black-box/src/app-tabs.ts` already has a runner-facing top-level model with `recipes`, `runs`, `fleet`, `builder`, `event-stream`, and `advanced`, which is a good migration foothold.
- The current Distributed Recipes surface already implements the hard backend workflow: create/list/read/stage/start/cancel/export through the control server.
- `packages/shared-test/rallar-bb-test` already owns the right contracts: schemas, distributed-run manifest, target resolution, rollups, monitor derivation, composite result normalization, fleet reports, artifact analysis, and runtime diagnostics.
- `apps/rallar-black-box/src/distributed-recipes.ts` is now only a re-export of `@shared-test/rallar-bb-test/distributed-run-monitor.ts`, which confirms the direction: keep analysis logic in `packages/shared-test`; make the SPA a tidy client.
- Remaining product gaps called out by the repo docs are exactly the rewrite's focus: retention UI, saved filters, artifact search, large-run virtualization, and large-run UX/accessibility.

## Recommended Approach

Use a strangler rewrite inside `apps/rallar-black-box`, not a new app.

Reasoning:

- It preserves existing dev scripts, Playwright config, app URL, control-agent bootstrap links, and full-stack test harnesses.
- It avoids duplicating control-server and shared-test client code.
- It lets the new SPA run beside legacy panels behind a route or workspace flag until it is proven.
- It gives a clear rollback path while gradually shrinking `App.tsx`.

Alternatives:

- A separate `apps/rallar-black-box-next` would be cleaner at first, but it would duplicate bootstrap/config/test setup and risk drift.
- A pure refactor of the existing UI would preserve behavior, but it would not force the product simplification needed here.

## Proposal Analysis: Modern UI And Legacy Strangling

The proposed direction is doable and desirable: new UI elements can have a new, more modern, more interactive look and feel while existing UI elements remain available. The key is to make "new" and "legacy" explicit product and code boundaries.

Feasibility is high with the current stack. The app already uses React and Vite, so CSS Modules, dynamic imports, `React.lazy`, and route-level `Suspense` boundaries do not require a framework migration. The difficult work is state and ownership separation, not drawing the new controls. The main risks are global CSS leakage, hidden legacy effects continuing to run, and moving 28k lines into differently named mega-files; the controls below address those risks directly.

The recommended isolation level is a namespaced Recipe Console root plus CSS Modules and separate lazy route trees. Shadow DOM would complicate focus, portals, testing, and shared providers; an iframe would complicate auth/runtime state and deep links. Neither buys enough isolation for this SPA.

Recommended policy:

- Build the Recipe Console as a new UI surface with its own shell, tokens, components, CSS namespace, and interaction model.
- Preserve existing UI elements as `Legacy` or `Advanced Legacy` surfaces. Do not delete them during the rewrite.
- Hide each legacy panel from the primary path only after its replacement workflow passes its cutover gate. Until then, keep that legacy workflow visible or make the new workflow explicitly opt-in.
- After cutover, hide legacy panels from primary navigation, not merely with CSS. Keep them reachable through explicit advanced navigation, old deep links, or contextual "open legacy diagnostic" actions.
- Do not restyle all legacy panels as part of the first rewrite. That would spend effort on surfaces that are no longer primary and would increase regression risk.
- Do not mix new and legacy components in one view unless the legacy component is inside a clearly framed compatibility slot.
- Keep old query aliases working. Existing `tab=distributed-recipes`, `tab=run-manager`, and `advancedSurface=...` links should redirect or open the matching legacy/advanced surface.
- Load legacy surfaces through route-level dynamic imports where practical. Keeping a surface available does not require shipping and mounting all of it on the Recipe Console's default route.
- New bug fixes should land in extracted modules or shared helpers, not as more code inside `App.tsx`.

This means the user-facing product gets a fresh interaction layer, while the operational escape hatches stay available. It also avoids the risky "big bang redesign" failure mode where the old UI is removed before the new workflow proves itself.

## Look And Feel Direction

The new Recipe Console should feel like a modern operational cockpit: fast, compact, direct, and tactile. It should not inherit the current whole-app visual language by default.

Visual direction:

- Calm dark-on-light or neutral-on-light workspace, with strong semantic colors for pass, fail, warning, stale, selected, and running states.
- Dense but tidy layout: thin rails, clear dividers, compact tables, stable row heights, and a persistent status/command bar.
- A dominant central work surface for run execution, monitoring, artifact evidence, and timing analysis.
- Inspector rail for selected agent/recipe/command/failure/diagnostic details.
- Modern interactive controls: segmented view switches, searchable command palettes or comboboxes, drawer/bottom-sheet filters, selectable matrix cells, copy-link buttons, and inline diff/timing inspectors.
- Smooth but restrained motion for live updates, row selection, drawer transitions, and status changes. Respect reduced motion.
- No marketing hero, no decorative card pile, no purely atmospheric gradients, no 3D, and no map-first UI unless geography is the evidence.

Implementation direction:

- Create a small root token/reset layer under `.recipe-console`, then use co-located CSS Modules for shell, primitives, and feature views. Do not replace the 7k-line global stylesheet with one new giant `recipe-console.css`.
- Keep existing global CSS loaded for legacy routes during migration, but add a CSS leakage test page containing representative legacy and Recipe Console controls side by side.
- Import Recipe Console styles after the legacy global sheet, give every new control an explicit local class, and inspect computed styles in the leakage fixture. Avoid broad `all: initial` resets that would damage accessibility and native control behavior.
- Keep component radii modest, around 6-8px, matching an operational tool rather than a playful landing page.
- Use icon buttons for common actions where possible: refresh, copy, export, cancel, start, filter, search, open inspector, close drawer.
- Keep text code-native and selectable. Do not bake labels into SVG or images.
- Make row/cell selection obvious and persistent. Hover can preview, but click/tap commits selection and updates the inspector plus URL state.
- Treat mobile as a sibling state: command bar first, verdict next, then primary action and evidence. Move filters/inspector to drawers.

## Legacy UI Policy

Existing UI elements should be kept, but progressively isolated:

- First: register every current surface in a migration matrix with an owner, destination, route alias, state requirements, and cutover test.
- Second: extract legacy panels from `App.tsx` into one file per surface under `src/legacy/...` without changing behavior or styling.
- Third: introduce the Recipe Console workflow beside its legacy equivalent. Keep the legacy surface primary until the replacement passes its workflow-specific cutover gate.
- Fourth: hide the replaced surface from primary navigation and route contextual diagnostic links into either the new inspector or the relevant legacy panel with current run/group/agent context.
- Fifth: preserve legacy routes until a separate explicit retirement task has usage evidence, parity tests, and a rollback plan. The strangler project itself does not delete them.

Legacy mounting rule:

- "Hidden" normally means absent from primary navigation and unmounted from the DOM.
- Heavy legacy panels should be loaded with `React.lazy(...)` or equivalent route-level dynamic imports and mounted only when opened.
- Legacy panels that preserve unsaved drafts or legitimately own a long-running local task may temporarily stay mounted. Record that exception in the migration matrix, then move serializable drafts to explicit persistence before unmounting them.
- Background execution and polling should belong to a store/service with a lifecycle independent of panel visibility. Do not keep an entire panel mounted only to preserve a request loop.
- New panels should not rely on legacy component internals. They should consume shared helpers and control-server APIs directly.

`App.tsx` rule:

- `App.tsx` should become routing and provider glue only.
- No new primary product panel should be added directly to `App.tsx`.
- New work goes under `src/recipe-console/**`.
- Legacy extraction goes under `src/legacy/**`.
- Shared deterministic behavior goes under `packages/shared-test/**` when it is useful outside the SPA.

Structural rule:

- Do not create `LegacyRunnerSurfaces.tsx` or `RecipeConsoleApp.tsx` as replacement monoliths. A surface registry may be central, but each substantial route, controller hook, table, inspector, and visualization gets a focused module.
- Extract behavior and rendering separately when a panel mixes network effects, derived data, and large JSX. Prefer `use<Feature>Controller.ts` plus focused view components over transferring the whole function unchanged into another huge file.
- Temporary adapters may translate existing props into a new route contract. They must not become a second source of recipe, rollup, timing, or target-resolution logic.

### Initial Strangler Matrix

| Current surface | New destination | Transition treatment | Cutover proof |
| --- | --- | --- | --- |
| `RunnerRecipesPanel` | `Execute` | Keep as legacy recipe launcher while the new guided flow is opt-in | Select recipe, resolve targets, stage, start, cancel, export, and restore deep link through visible controls |
| `DistributedRecipesPanel` | `Execute` and `Monitor` | Preserve under `Advanced Legacy`; use as the operational fallback during early cutovers | Control-server create/list/read/stage/start/cancel/export parity, including error and stale-agent states |
| `RunnerRunsPanel` and `DistributedRunMonitorPanel` | `Monitor` | Keep old run links valid and offer `Open legacy monitor` from the new run inspector | Running, pass, failure, timeout, cancellation, reconnect, and selected evidence Playwright coverage |
| `ImportedDistributedArtifactAnalysisPanel` and `DistributedRunAnalysisReportPanel` | `Analyze` | Preserve legacy artifact analysis until import and issue-summary parity | Import valid/partial/invalid bundles and find the first actionable failure without raw JSON |
| `DistributedRunComparePanel` | `Tune` and `History/Compare` | Reuse shared comparison derivation; retain legacy comparison deep link | Baseline selection, timing deltas, participant/failure deltas, and URL restoration |
| `RunnerFleetPanel` and fleet helpers | `Fleet` | Move feature by feature; keep existing fleet route as fallback | Filters, failure signatures, timing evidence, map layers, and URL state restore |
| `FlowBuilderPanel` and authoring panels | `Advanced Legacy`, then focused authoring entry points | Keep available; do not block the core execution cutover on a full builder redesign | Existing authoring and schema tests plus a visible create/edit/run flow |
| `RunManagerPanel`, `WorkbenchPanel`, `SharedTestPanel` | `Advanced Legacy` | Lazy-load and deep-link with current context | Existing actions still work and returning to Recipe Console preserves selected run |
| Auth, Groups, WS, RTC, Data, CRDT, Media, Server, Trace, and Event Stream panels | `Advanced` diagnostics | Keep as contextual diagnostics; do not visually merge them into the new shell | Failure-to-diagnostic links open the right surface with group/agent/command context |

Each row can cut over independently. There is no single release where every old panel must become hidden at once.

## Product Shape

The first screen should be the actual operator workflow, not a landing page:

1. Top command bar: control-server state, selected control run, selected distributed run, group/application/workspace, targetable agents, live/stale/offline status, first failure.
2. Left navigation: `Execute`, `Monitor`, `Analyze`, `Tune`, `Fleet`, `Advanced`.
3. Center work surface: the selected run or workflow, with failures and current status visible first.
4. Right inspector: selected recipe, agent, command, failure, diagnostic, artifact, or timing sample.

The default route should open `Execute` with a meaningful current run if available. If a selected distributed run is active, the SPA should prefer `Monitor`. If an artifact is imported, it should prefer `Analyze`.

### Primary Workflows

`Execute`

- Pick recipe profile: ACK, WS receive, RTC stream, parallel smoke, wait/assert, custom.
- Resolve targets from current group and control-agent identity.
- Explain missing/stale/offline/duplicate/wrong-group agents before staging.
- Show a compact manifest preview and preflight tree.
- Provide `Stage`, `Start`, `Cancel`, `Export`, and `Copy link` as the main commands.
- Keep raw JSON available, but not central.

`Monitor`

- Show verdict first: running, passed, failed, timed out, cancelled.
- Show failures before timeline noise.
- Show agent x phase matrix: target, stage ACK, barrier, run, result, diagnostics.
- Show per-recipe progress and composite drilldowns for `loop`, `parallel`, `wait`, `assert`, and `rtc.stream`.
- Correlate runtime diagnostics with failures by agent, command, recipe, and near-time evidence.
- Keep last-known-good data visible during reconnects.

`Analyze`

- Load distributed-run artifacts from the control server or from local files.
- Validate files by bundle profile and schema version. `distributed-run.json`, `manifest.json`, and `control-run.json` form the core distributed bundle; report, result, event, failure, and metadata evidence may be optional. Keep supported partial bundles usable with file-specific warnings.
- Render the failure verdict, likely cause, next action, minimal fix area, affected agents/regions, evidence file, and verification command.
- Provide artifact search by agent, command, topic, diagnostic type, payload summary, failure category, and time window.
- Produce issue-ready summaries from `analysis.summaryMarkdown`, `fixProposalMarkdown`, and `performanceMarkdown`.

`Tune`

- Treat timing as a first-class recipe design loop, not a buried metric.
- Compare selected run against a baseline or previous run.
- Surface command timing: min, p50, p95, p99, max, average, spread, outliers.
- Surface stream timing: planned/completed/failed/dropped frames, in-flight drops, backpressure, achieved Hz, max drift, late frames, p50/p95/p99/max send duration, slowest stream agents.
- Suggest likely recipe knobs:
  - dropped frames or in-flight drops: lower `rateHz`, raise `maxInFlight` carefully, or shorten payloads
  - high drift but few drops: lower cadence, inspect scheduler pressure, reduce concurrent work
  - high p95/p99 on one agent: inspect region/browser/network, do not blindly loosen global thresholds
  - stage or barrier timeouts: tune `ackTimeoutMs` or `barrier.timeoutMs` only after target identity/staleness is clean
  - no peers/no route: fix target resolution/readiness before changing stream thresholds

`Fleet`

- Keep fleet as a scale analysis view, not the main execution flow.
- Show live agents, historical run matrix, repeated failure signatures, region summaries, timing distributions, and the current deterministic SVG world map.
- Use map layers only when geography explains failures or latency. Do not make the map the default evidence for non-spatial problems.

`Advanced`

- Keep direct Rallar tools here: Auth, Groups/Clients, WebSocket, RTC/Realtimes, RTC Diagnostics, Rallar Data, CRDT, Media, Rallar Server, Flow Builder, Local Workbench, Shared Test.
- Make these diagnostics discoverable from failures: e.g. a WS ticket failure can link to Auth/WS diagnostics with the current context.
- Do not let advanced tools dominate first-run navigation.

## Visualization Strategy

Analytical jobs:

- monitoring: current run state, stale/offline agents, active failures
- comparison: run A vs run B, baseline vs candidate, recipe profile deltas
- time change: lifecycle timeline, command duration, stream cadence
- distribution: latency percentiles, outliers, jitter, drift
- matrix: agent x phase, agent x run, recipe x agent
- artifact/reporting: issue-ready evidence and replayable artifacts
- geography: fleet region/agent only when location is evidence-bearing

Chart and artifact families:

- Verdict strip: semantic HTML, always visible, no hover dependency.
- Agent phase matrix: table/grid with colored cells and in-cell counts.
- Lifecycle timeline: compact SVG or CSS grid timeline; use labels and direct annotations.
- Latency distribution: percentile strips, box/whisker-like rows, and small multiples by agent/recipe.
- Stream frame disposition: stacked bar for completed/failed/dropped/in-flight-dropped frames.
- Drift/jitter over time: SVG line/scatter for normal runs; Canvas only if event counts become too dense.
- Compare runs: delta table plus direct labels for changed recipes, participants, failures, timing, and received messages.
- Fleet map: existing deterministic SVG; keep labels code-native and use explicit coordinates or documented lookup only.

Renderer choices:

- Use React/HTML/CSS for tables, metrics, inspectors, forms, and low-density charts.
- Use SVG for timelines, percentile strips, compact maps, route summaries, and annotated distributions.
- Use Canvas only for large event streams or dense timing plots after profiling.
- Avoid WebGL/3D. It adds little analytical value for recipe execution and would make the SPA heavier.

Mobile behavior:

- Mobile opens with verdict plus the selected run summary, then primary action.
- Put target filters, recipe filters, and inspectors in drawers/bottom sheets.
- Replace hover with tap/focus selection and step-through controls.
- Preserve active filters, selected run, source status, and stale/live indicator outside closed panels.
- Provide mobile landscape support for timelines, matrices, and fleet map.

## Architecture

Keep reusable behavior in packages and app code thin:

```text
packages/shared-test/rallar-bb-test/
  distributed-run.ts
  distributed-run-monitor.ts
  distributed-artifact-analysis.ts
  control-snapshots.ts
  fleet-report.ts
  schema.ts

apps/rallar-black-box/src/recipe-console/
  app/RecipeConsoleApp.tsx
  app/RecipeConsoleShell.tsx
  app/RecipeConsoleShell.module.css
  app/navigation.ts
  app/url-state.ts
  design/tokens.css
  design/reset.css
  control/control-api.ts
  control/control-query.ts
  execute/
  monitor/
  analyze/
  tune/
  fleet/
  advanced/
  ui/

apps/rallar-black-box/src/legacy/
  LegacyAppShell.tsx
  LegacySurfaceRouter.tsx
  legacy-surface-registry.ts
  runner/LegacyRecipesRoute.tsx
  runner/LegacyRunsRoute.tsx
  runner/LegacyDistributedRecipesRoute.tsx
  runner/LegacyRunManagerRoute.tsx
  runner/fleet/RunnerFleetPanel.tsx
  runner/LegacyBuilderRoute.tsx
  diagnostics/
```

Proposed app responsibilities:

- `control-api.ts`: typed fetch wrappers around existing control server endpoints. It can start by wrapping functions from `src/control-run-manager.ts`.
- `control-query.ts`: polling, stale state, refresh cadence, and snapshot bounds.
- `url-state.ts`: URL-backed workspace state: view, run IDs, filters, selected agent, selected command, compare IDs, timing metric.
- `design/tokens.css`: new Recipe Console design tokens scoped to `.recipe-console`. Keep it independent from existing app-wide panel styles.
- `design/reset.css`: a narrow Recipe Console normalization boundary, not a whole-application reset.
- `*.module.css`: co-located shell, primitive, and feature styles. Keep each module focused and avoid new broad selectors.
- `execute/`: recipe catalog, target resolution, manifest builder, stage/start/cancel actions.
- `monitor/`: verdict, progress matrix, timeline, diagnostics, composite drilldowns, selected-inspector routing.
- `analyze/`: artifact import, artifact validation, failure analysis, issue summary, artifact search.
- `tune/`: timing distributions, stream disposition, baseline comparison, recipe tuning hints.
- `fleet/`: fleet board, heatmap, region summaries, map, report export.
- `advanced/`: compatibility bridge to legacy direct Rallar tools while they are hidden, extracted, or moved behind contextual diagnostics. It owns links and route context, not the legacy implementations.
- `ui/`: compact reusable primitives: button, segmented control, metric, status pill, table, empty/error/stale state, disclosure, drawer, toolbar, inspector.
- `legacy/LegacySurfaceRouter.tsx`: the only compatibility mounting boundary used by Recipe Console.
- `legacy/legacy-surface-registry.ts`: stable IDs, labels, dynamic imports, old query aliases, context codecs, and cutover status.
- `legacy/runner/**` and `legacy/diagnostics/**`: one route adapter per substantial existing surface. The adapter may compose smaller extracted files, but there is no aggregate mega-component.

Target ownership:

- `App.tsx`: app bootstrap, providers, auth gate, high-level routing. Below 1,500 lines is an intermediate extraction checkpoint; the final target before the Iteration 12 default flip is below 800 lines.
- `RecipeConsoleApp.tsx`: compose new console routes and shared providers. Target below 400 lines.
- `LegacySurfaceRouter.tsx`: resolve and lazy-load one legacy route. Target below 250 lines.
- Feature route files: own orchestration for one workflow. Target below 700 lines.
- Component files: presentational and focused. Target below 300 lines unless a table/chart renderer needs more.
- CSS Modules: target below 400 lines. Split by feature or component when selectors stop sharing one ownership boundary.
- Shared helpers: pure functions with tests; move to `packages/shared-test` when both live UI and artifact/CI analysis need them.

Keep these in `packages/shared-test` or move them there if currently app-local:

- timing sample derivation and percentiles
- stream timing summaries
- failure classification and next-action suggestions
- artifact parsing and validation
- target resolution and stale/offline/duplicate explanations
- compare-run derivation
- fleet aggregation and failure signatures

Do not import legacy React panels into new Recipe Console views except through `LegacySurfaceRouter` or an equivalent compatibility boundary. The imports behind that boundary should be dynamic so the default Recipe Console chunk does not eagerly include every legacy panel.

### `App.tsx` Decomposition Sequence

Do the split as behavior-preserving slices. Do not combine a panel move with its redesign.

1. Move navigation parsing/writing, legacy alias resolution, and route normalization behind typed modules while keeping current tests green.
2. Extract the login/bootstrap/provider gates from `App()` into focused shell components. Keep runtime store and auth behavior unchanged.
3. Extract the current tab composition into `LegacyAppShell.tsx`; `App.tsx` selects `RecipeConsoleApp` or `LegacyAppShell` and supplies only shared bootstrap context.
4. Extract one leaf surface at a time, starting with the five distributed-run panels named in Iteration 1. Move its private controller hook, view components, and styles together.
5. Replace static legacy imports in the route registry with dynamic imports. Verify that inactive surfaces no longer mount effects or appear in the initial Recipe Console bundle.
6. Move deterministic derivation used by both old and new views into `packages/shared-test`; keep app adapters thin and preserve public exports.
7. Flip each workflow to Recipe Console only after its matrix cutover proof passes. Keep the old route and rollback switch.
8. Make Recipe Console the default only after all core workflow gates pass; leave `Advanced Legacy` available.

Add a focused structure test, for example `packages/tests/rallar-black-box/app-structure.test.ts`, that guards these invariants:

- `App.tsx` declares no feature `*Panel` components.
- Recipe Console modules do not import from `src/legacy/**` except the compatibility router contract.
- Legacy surface entries resolve through dynamic imports.
- The default Recipe Console entry does not statically import direct Rallar diagnostics.

## State Contract

Use the URL for shareable operational state:

- `v` for the URL-state schema version
- `experience` with `recipe-console` or `legacy` during migration
- `view`
- `controlRunId`
- `distributedRunId`
- `agentId`
- `recipeId`
- `commandId`
- `diagnosticSeverity`
- `transport`
- `historyQuery`
- `historyGroup`
- `historyRecipeId` (never overload operational `recipeId`)
- `historyProfile`
- `failureCategory`
- `status`
- `from`
- `to`
- `compareLeft`
- `compareRight`
- `timingMetric`
- `fleetRegion`
- `fleetMapLayers`
- `legacySurface` only when an advanced legacy route is active

Use local storage only for personal defaults:

- collapsed panels
- last control URL
- preferred page density
- recent recipe profile
- bounded saved History-filter presets
- theme if added later

Do not persist secrets, raw credentials, large artifact payloads, transient hover state, pointer positions, or animation state in the URL or local storage.

Parse, validate, normalize, and serialize this state through one typed codec. Incoming links override personal defaults. Use history replacement for high-frequency range/viewport changes and push entries for committed view, selection, filter, comparison, and legacy-route changes. Invalid or stale URL state should fall back visibly while preserving every valid field.

## Iterative Plan

### Execution ledger

The canonical product contract is the [Recipe Console product spec](../apps/rallar-black-box/docs/recipe-console-product-spec.md), and surface cutover ownership is the [Recipe Console migration register](../apps/rallar-black-box/docs/recipe-console-migration-register.md). This ledger records execution status without duplicating the iteration details below.

| Iteration | Status | Exit tracking |
| --- | --- | --- |
| 0 — Product Cut And Evidence Map | **Complete** | Product cut, five observable stories, v1 URL contract, 14-item Ready-State traceability, full surface register, exact rollback URLs, and the qualified baseline below are recorded. No runtime behavior changed. |
| 1 — Extract Pure App Helpers | **Complete** | Behavior-preserving helper, presentation, controller, and shell-composition slices reduce `App.tsx` from 28,265 to 234 lines. `App` now owns runtime/bootstrap, auth gates, shared shell controllers, and experience composition only; `LegacyAppShell` delegates the exact tab tree to six bounded hook-free groups. The exit evidence below passed without a hide, cutover, route, public-export, control-contract, or stylesheet change. |
| 2 — New Recipe Console Shell | **Complete** | Direction A, Signal Ledger, is implemented as an explicit `v=1` seeded experience through code head `a397642`. The fidelity ledger records URL/history, responsive/accessibility, CSS/chunk isolation, concept, Browser-fallback, review, and fresh validation proof. No workflow is cut over and no legacy primary surface is hidden. |
| 3 — Control Connection And Agent Board | **Complete** | The canonical bounded control adapter, serialized root query, explicit operational context, URL-backed run/agent selection, repository-derived board, credential-origin policy, and deep snapshot validation are implemented through `a7df46f`. Independent review, mocked lifecycle, actual local-control read, responsive/accessibility, legacy compatibility, server contracts, and qualified validation are recorded below; Ready-State #3 remains open for Iterations 4–5 and configured live/Postgres proof. |
| 4 — Execute Workflow MVP | **Complete** | Shared catalog/manifest/target truth (`3fe2574`), the bounded credential-aware execution API (`76092f6`), guided Execute UI (`8d44a99`), and lifecycle acceptance (`bddde71`) pass the code-backed exit. Fresh validation, browser fallback QA, review fixes, and the unavailable configured-live qualification are recorded below. Ready-State #2 is satisfied; #3 remains open for live Monitor observation, distinct live cancellation, and configured Postgres proof. Both legacy workflow rows remain visible and uncut. |
| 5 — Monitor MVP | **Complete** | Shared role-scoped progress and selected-failure correlation, context-keyed current/last-known truth, the bounded live Monitor, credential-aware Cancel/artifact actions, legacy Runs handoff, and canonical full-stack discovery are code-backed through `42eedae`. Ready-State #4 and #5 are satisfied. Ready-State #3 remains open because the configured Postgres lifecycle was unavailable and skipped, not passed. No default, navigation, legacy-row visibility, mount policy, or workflow cutover changed. |
| 6 — Artifact Analysis | **Complete** | Additive shared workspace/evidence truth (`f96b5b4`), the bounded failure-first Analyze workspace (`abe257e`), the complete safety matrix (`9b07330`), and exact keyboard/drop/handoff proof (`47c332d`) pass offline/control import, search, export/re-import, adversarial state, responsive/accessibility, and strangler proof. Ready-State #6 is satisfied. Legacy Runs, Distributed Recipes, Shared Test, and Run Manager remain visible and uncut. |
| 7 — Timing And Recipe Tuning Lab | **Complete** | Shared deterministic tuning truth (`cc17169`) and the real-evidence lazy Tune workspace (`382df72`) pass the exact timing, comparison, no-mutation, responsive/accessibility, CSS-isolation, chunk, legacy-handoff, review, and qualified full-suite exit below. Ready-State #7 and the bounded comparison evidence for #8 are code-backed. No legacy row is hidden or cut over. |
| 8 — History, Compare, Saved Filters, Retention | **Complete** | Preview-first retention, shareable filters/presets, bounded History, comparison reuse, cleanup reconciliation, and exact copied-link/retention acceptance are qualified through `fd9055e` and `f762749`. Fresh focused/complete/server/browser/legacy gates and independent re-reviews are green; the configured live/Postgres lifecycle is explicitly skipped, not passed. Ready-State #8 and #9 are code-backed. No legacy surface is hidden or cut over. |
| 9 — Large-Run Scale And Virtualization | **Complete** | One parsed shared pipeline, workerized Analyze, indexed Control/Monitor truth, and accessible deterministic windows now bound 15,000 artifact rows, 5,000 History/Tune pairs, 24,002 knobs, Execute/Monitor/retention pressure paths, and every mounted list. The exact production acceptance, same-machine candidate profile, 1,385-test app suite, 169 available Recipe Console browser cases, 28 legacy cases, four independent reviews, and final focus/fidelity repairs are green through `f8cef95`. Ready-State #10 is code-backed. Configured live remains an exact skip, not a pass; no legacy row, default, route, mount, public/control contract, or cutover changed. |
| 10 — Fleet And Geographic Evidence | **In progress** | Tasks 0–4 are code-backed through `0d046ca`: tolerant shared validation, deterministic report/geographic evidence, collision-safe identities, legacy parity adapters, bounded bundle transfer, a lazy authorized one-bundle capability, and exact pending-safe Fleet selection/handoff contracts pass a stable 267-test gate plus type/Deno/review proof. The reviewed [Fleet implementation plan](../docs/superpowers/plans/2026-07-14-rallar-recipe-console-fleet-geographic-implementation-plan.md) records the mandatory shared traversal correction before Task 5. The active-only legacy fallback and aliases remain unchanged; no row is hidden or cut over. |
| 11 — Advanced Diagnostics Bridge | Pending | Legacy surfaces remain preserved with the mount exceptions in the migration register. |
| 12 — Polish, Accessibility, And Default Flip | Pending | The default remains legacy/current behavior until all 14 Ready-State items have evidence. |

#### Iteration 10 implementation start — `7d25ab9`

Three independent repository audits and a direct source/test review confirm
that the plan's intended behavior-preserving Fleet extraction already landed
in a stronger form at `9e5b4b5`: `RunnerFleetPanel`, its controller, pure
helpers, and controlled views live under `src/legacy/runner/fleet/**`; `App.tsx`
owns no Fleet behavior; the panel mounts only for the active legacy Fleet tab;
and exact structure fingerprints require the shell to import that feature root
directly. Iteration 10 will not add the obsolete filename-only
`LegacyFleetRoute.tsx` wrapper. The legacy route and `fleet-report`/
`fleet-reports` aliases remain unchanged.

The child plan makes shared-test the canonical owner of new tolerant report
validation, stable report aggregation, indexed heatmap truth, timing, repeated
failure evidence, and provenance-bearing geography. The new Recipe Console
Fleet consumes the existing root query and indexed selection, adds no second
poll or credential owner, and is lazy/unmounted while inactive. Its map remains
secondary, routes require explicit target-agent fields plus two resolved
endpoints, and every potentially pressured evidence surface receives an exact
browseable window. Rebuild stays operational in the preserved legacy fallback.
The existing selected-report bundle endpoint is exposed only through a narrow
authorized lazy capability so exact Fleet artifact files—not merely their
opaque references—can be inspected/exported without a second poll. No existing
endpoint or artifact profile changes.

The clean `7d25ab9` baseline passes 74/74 focused legacy Fleet, map, URL, and
structure tests. A sandbox browser attempt was unavailable because Vite could
not bind `127.0.0.1:5176`; the identical authorized rerun passes all 3 legacy
Fleet cases, covering 20-agent report/heatmap/failure/timing/export evidence,
map-layer URL restoration, and 390×800 mobile use. This is planning and
baseline evidence only: the new Fleet capability, its canonical browser owner,
and the Iteration 10 exit remain open, and no row is hidden or cut over.

#### Iteration 10 shared evidence and boundary milestone — `0d046ca`

Tasks 1–4 add tolerant shared Fleet report/bundle validation, one-pass
deterministic report analysis, provenance-bearing geography, collision-safe
region/timing/route identities, and thin exact-parity legacy adapters. A
backward-compatible bounded bytes client and lazy authorized capability load
and retain at most one explicitly selected bundle without adding a poll,
credential owner, endpoint, or required artifact file. The pure workspace and
URL contracts preserve exact selections, keep unavailable truth pending until
owning evidence is authoritative, and use a History-searchable run identity
instead of incompatible Fleet signature/category filters.

After RED/GREEN resolution of independent review findings, the stable gate
passes 267/267 tests across 15 owner files, shared/app TypeScript, direct Deno
checks of the three new modules, and whitespace validation. Two final
re-audits are clean. No default, primary navigation, legacy visibility/mount,
alias, rollback URL, existing public import, control-server contract, or
cutover changed.

Task 5 remains open. Its repository review found that the composed shared
analysis permanently projects only the first bounded rows and the initial
workspace model performs a second region index. The next prerequisite is one
shared indexed collection with complete first/middle/final window projection;
the UI must not duplicate aggregation or claim traversal before that lands.

#### Iteration 9 Tasks 4–5 Analyze window checkpoint — `6d90061`

Analyze now composes the shared retained-catalog cursor into one native,
fingerprint-authoritative evidence list with exact Previous/Next range truth
and at most 64 mounted rows. URL filters, local/Control import, selection,
inspector focus recovery, export/reimport, and legacy Runs/Shared Test handoffs
remain operational. Producer compaction unavailable, index omission, matching,
and browseable render-window omission are reported separately. Initial,
pending, unavailable, and completed-zero searches no longer publish invented
counts or no-match truth, and exact identifiers are bidi-isolated in rows and
the inspector.

The recorded Task 5 exit is 129/129 focused Analyze tests, 132/132
structure/History/retention tests, app TypeScript, a 631-module production
build with its Analyze worker, the reciprocal experience-chunk assertion, and
22/22 expanded Analyze Chromium cases. The canonical production case traversed
all 235 windows, collected 15,003 unique IDs with no gap or duplicate, mounted
no more than 64 rows, reached exact final range
`Showing 14,977–15,003 of 15,003 retained matches.`, traversed backward, and
found the exact final event/result needles in 15.4 seconds. After the final
truth-label review fix, the directly affected unit and browser slices passed
22/22 and 15/15 respectively. Independent re-review closed every Critical and
Important finding.

The in-app Browser returned exactly `No browser is available`, while
`agent.browsers.list()` returned `[]`; Playwright/System Chromium is fallback
evidence, not an in-app Browser pass. These tests use deterministic/simulated
fixtures and make no live-service claim; the configured-live skip remains
unchanged. At this checkpoint Tasks 6–9 were open; Task 6 is now green below,
while parent Iteration 9 stays in progress for Tasks 7–9 and final profiling/
exit proof. No legacy visibility, mount policy, deep link, rollback URL,
navigation default, or cutover changed.

#### Iteration 9 Task 6 foundation checkpoint — `0b260ec`, `a258a9e`, `bbb2548`, `ef78e75`

The shared Monitor/report path now performs one indexed derivation per source
snapshot with preserved 5,000-row observable hashes and compressed role/recipe
membership. Independent review added exact source/run authority, narrow weak
retention, lazy cross-snapshot fallback work, and report-local counters. Both
2,000×2,000 all-unroled and same-role adversarial matrices retain only linear
descriptors/counts; focused timings were 6–8 ms. Fresh focused Monitor/index and
structure validation passed 183/183 before the milestone commit, plus shared
TypeScript/Deno, app TypeScript, and the production build.

Exact root/fallback response documents now receive invisible session-local
revision tokens without changing public control-manager signatures, server
contracts, snapshot own keys, or JSON. Review narrowed raw-text association to
the two polling endpoints, leaving artifact/fleet/command responses untagged.
The one-entry internal ordinal topology retains only primitives/ordinals,
rebinds current-poll objects, and keeps global-first, ID/control-pair-first,
compatible-source, and board duplicate policies separate. Its selected overlay
passed 20,000 randomized legacy-parity projections after duplicate override
and nullish role-fallback fixes; the 5,000-pair exact-clone hit performs zero
index/global rebuild work.

Analyze remains mounted as the artifact/worker/Tune lifetime owner, but outside
the Analyze view it returns one frozen empty option set before collection
traversal and sends no search request. A retained artifact and Tune facade
survive Execute, Monitor, History, and Tune; entering Analyze sends one latest
search and restores stable current-object options. Direct proof is 14/14,
broader Analyze regression proof is 115/115, and app TypeScript is green.

This is a foundation checkpoint, not the Task 6 or Iteration 9 exit. Indexed
Control/board/Monitor consumer composition, browseable Monitor windows,
browser-mounted counts/heartbeat, Task 7 pressure lists, final profiling, and
the complete Ready-State #10 production-browser gate remain open. No legacy
surface, primary navigation row, route, lazy-mount policy, rollback URL,
default, or cutover changed.

#### Iteration 9 Task 6 Monitor scale checkpoint — `8c630fc`

The foundation topology is now composed into the always-on Control selection
and agent-board consumers without changing public snapshots or server
contracts. Exact-revision clone polls reuse indexed topology with zero global
rebuild visits; trusted absence is constant-time, active control selection
projects only the active ordinal, and selected overlays preserve legacy
duplicate, ordering, object-identity, cross-control, and synthetic behavior.
Inactive Analyze still performs zero run-option traversal or search work.

Monitor now replaces its former prefixes with explicit accessible windows in
the main ledger and inspector. Failures, agents, recipes, readiness,
diagnostics, timeline, events, composites, command evidence, failure
destinations, and diagnostic links expose exact range/outside-window truth and
browse every retained source identity without gaps or duplicates. Closed
disclosures mount no retained rows. Filter/fingerprint changes reset only the
owning cursor, while polling and above/below-budget changes preserve or recover
focus through a persistent range control. Failure-first ordering,
current/last-known truth, operations, correlations, v1 URL state, and exact
bidi identifiers remain authoritative.

Settled validation passed 226/226 focused Vitest tests across 11 files
(28 query, 24 structure, 10 shared topology, 3 cache, 69 API, 27 Monitor state,
17 board, 26 selection, 1 provider, 13 main-window, and 8 inspector-window),
app TypeScript, a 655-module production build, reciprocal
`RecipeConsoleApp-D4wdYE2J.js` / `LegacyExperience-DzD-0gim.js` chunk proof,
and `git diff --check`. Only the existing greater-than-500-kB build advisory
remained. Stable-source browser proof passed 11/11 combined new/existing
Monitor cases plus 6/6 responsive/accessibility and CSS-isolation cases; the
large fixture's 4/4 cases cover desktop 1440×900, genuine-touch portrait
430×932, genuine-touch short landscape 932×430, keyboard/focus, reduced
motion, operational states, URL-stable reverse traversal, bounded mounts, and
clean Direction A containment.

Two earlier browser attempts overlapped live source edits and were unavailable
as product verdicts: one ran during consumer composition, and one during a
neutral binding-file move. Both affected sets reran fully green on stable
source. A direct `tsx --test` UI attempt was unavailable because Node cannot
load CSS modules; Vitest is the authoritative passing owner. The in-app Browser
returned exactly `No browser is available`; Playwright/System Chromium is the
fallback, not an in-app Browser pass. The configured-live lifecycle remains
skipped, not passed, for exactly: `Set RALLAR_BLACK_BOX_FULL_STACK=1 with
Postgres-backed apps/api-v1, apps/rallar-black-box-control-server, and
apps/rallar-black-box available.` Indexed-consumer, browser, and final exit
re-reviews are clean after three Important exit-review findings received
focused RED/GREEN fixes.

Task 6 is complete, but Ready-State #10 and parent Iteration 9 remain open for
Tasks 7–9: History/retention/Execute/Tune pressure-list composition, canonical
scale acceptance, the remaining heartbeat measurement, and final candidate
profiling. This checkpoint changed no primary/default navigation, legacy row
visibility or mount, deep link, rollback URL, public/control contract, or
cutover, and it hid no legacy row.

#### Iteration 9 qualified exit — `58070bf` through `f8cef95`

History now traverses 5,000 run pairs in 80-row windows; retention consequences
use exact 50-row windows; Execute bounds 250 run choices and 240 targets; Tune
indexes 5,000 paired runs and 24,002 editable knobs while deriving performance
for only the explicit comparison pair. Searchable disclosure/listbox controls
mount at most 100 options and preserve exact unavailable/invalid truth,
keyboard, touch, focus, URL history, and unmounted closed-popup DOM. The legacy
Shared Test importer alone displays generic compaction truth. Analyze remains
workerized and mounts at most 64 rows; every Monitor main/inspector pressure
collection is browseable without gaps, duplicates, hidden rows, or changed
authority.

The exact production-port Ready-State #10 owner passes with 12,000 events,
3,000 results, 5,000 History pairs, 5,000 Tune pairs, 24,002 knobs, Execute,
Monitor, retention, first/middle/last traversal, reduced motion, desktop,
tablet, genuine-touch portrait/landscape, both CSS load orders, lazy chunks,
and unmount cleanup. One Analyze pipeline pass visits eight files, parses six
JSON documents, passes each of two JSONL files once, and parses exactly 15,000
nonempty rows. The Tune accepted→paint→held-RPC protocol advances its event-loop
heartbeat and exact-clone polls reuse catalog/knob indexes.

At 15,000 rows, the clean same-command candidate profile improved model median
114.584→73.337 ms (0.640x), approximate p95/max 115.246→79.725 ms (0.692x),
search median 0.870→0.860 ms (0.988x), and retained model heap median
10,678,856→10,028,264 bytes (0.939x). No size crossed the 1.25x advisory
threshold. Exact structural counters and browser behavior, not milliseconds or
heap, are acceptance gates. Canvas is deferred with measured reason: pressure
was variable-height row/option cardinality and repeated derivation, not a dense
plot; workers, indexes, and accessible windows resolve it without Canvas cost.

Fresh final-head validation passed 131/131 app files and 1,385/1,385 tests;
shared/app TypeScript; seven shared Deno entries; the 699-module production
build and reciprocal experience-chunk proof; 169/170 Recipe Console Chromium
cases with the sole configured-live owner skipped; and 28/28 legacy navigation/
agent-ticket cases. The canonical scale case passed in 27.7 seconds inside the
complete 48.8-second browser run. Four independent algorithm/performance,
worker/state, UI/accessibility/browser, and strangler/cutover reviews are clean
after focused RED/GREEN repairs. Final focus priority is connected trigger,
exact owning range anchor, visible selection dock, then named work surface;
hidden or otherwise unfocusable candidates fall through only after focus
verification. Direction A remains approved and the fidelity ledger records the
reviewed selector baseline updates.

The in-app Browser remained unavailable exactly as `No browser is available`
with `agent.browsers.list() === []`; Playwright/System Chromium is fallback
evidence, not an in-app Browser pass. Configured live/Postgres remains skipped,
not passed, for exactly: `Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed
apps/api-v1, apps/rallar-black-box-control-server, and apps/rallar-black-box
available.` No control-server source changed. Ready-State #10 is code-backed;
Ready-State #3 stays open for its configured-service execution. No default,
primary navigation, legacy visibility/mount, deep link, rollback URL, public
export, existing control contract, or cutover changed, and no legacy row was
hidden. Iterations 10–12 remain open.

#### Iteration 0 baseline and validation evidence

| Evidence | Recorded result and qualification |
| --- | --- |
| Isolation | Worktree `/private/tmp/ar-eye-hunter-worktrees/rallar-black-box-spa`; branch `codex/rallar-black-box-spa-reimplementation`; base `9ce0490`. |
| Runtime | Local Node `26.5.0`; CI uses Node 24. This variance remains an explicit risk below. |
| `npm --workspace rallar-black-box run typecheck` | Passed. |
| Focused five-file Vitest slice | 60/60 passed. |
| `npm --workspace rallar-black-box run build` | Passed with the existing large-chunk warning; the `index` chunk was about 1.22 MB minified. |
| Broad app unit run | 310/312 passed in the sandbox. Both failures were caused by denied local IPC/loopback; the focused socket-dependent file then passed 9/9 outside that restriction. The baseline is green with this environmental qualification, not an unqualified 312/312 sandbox claim. |
| Live/Postgres coverage | Not run in Iteration 0 and not represented as passed. |

#### Binding decisions

- The broad Iteration 1 exit criteria govern. Deliver them through multiple reviewed extraction tasks rather than weakening the criteria.
- The final `App.tsx` target is below 800 lines. Below 1,500 lines is only an intermediate checkpoint.
- `control-run-manager.ts` remains the canonical typed control-server client until extraction. `recipe-console/control/control-api.ts` must delegate to or re-export it rather than duplicate endpoints or types.
- Artifact validation is bundle-profile- and schema-version-aware. Supported partial bundles remain usable with visible file-specific warnings.
- Iteration 8 retention preview is a backward-compatible, non-destructive dry run, for example an optional `dryRun: true`, followed by explicit destructive confirmation. The existing destructive default must not change silently.
- Iteration 9 uses explicit accessible Previous/Next windows as variable-height
  DOM virtualization; fixed-height spacer tables and a new virtualizer
  dependency are rejected. Window state is ephemeral and model/query-bound.
- Iteration 9 preserves existing artifact profiles. Generic
  `artifact-index.json` compaction/truncation remains solely in the legacy
  Shared Test importer because its runner identity cannot authoritatively prove
  association with a distributed-run artifact.
- Producer compaction, shared-index omission, and current render-window
  omission are distinct. Only render-window omissions are browseable; no UI may
  invent searchable rows for producer-compacted evidence.
- Timing and heap measurements are same-machine evidence, not absolute CI
  gates. Exact cardinality, traversal, mounted-DOM, parse-count, cancellation,
  and event-loop-progress invariants are executable gates.
- No Canvas timing plot is added without measured dense-DOM pressure. Current
  Recipe Console has no such plot, so Canvas is explicitly deferred.
- Fleet's behavior-preserving legacy controller/view extraction already lives under `src/legacy/runner/fleet/**`. The new Fleet view consumes shared deterministic helpers and must not import a legacy panel.
- Existing mounted-state guarantees are temporary documented exceptions. Draft, polling, subscription, media, and execution ownership must migrate before the corresponding view is lazily unmounted.
- Old aliases deterministically open the documented legacy surface during migration. New Recipe Console URLs use the versioned codec.
- The default flip is an explicit Iteration 12 cutover and occurs only after all 14 Ready-State items have evidence.

#### Iteration 7 tuning lab implementation start — 2026-07-12

The critical repository audit confirmed that Tune still renders only the
`high-latency-rtc` seed even though shared artifact analysis already owns the
required command and RTC stream health metrics and the v1 codec already owns
comparison and timing selection. The tests-first
[implementation plan](../docs/superpowers/plans/2026-07-12-rallar-recipe-console-tuning-lab-implementation-plan.md)
therefore replaces seed ownership with shared deterministic knob inventory,
validated clone-only candidate patches, evidence-backed tuning hints, explicit
comparison through the existing `compareDistributedRuns(...)`, and a bounded
Tune composition fed by the retained Analyze artifact and one root control
query.

Binding decisions are deliberately conservative: comparison inputs remain
explicit; incompatible pairs warn without tightening the public compare API;
reference-only recipes expose no invented knobs; operator-entered values are
required before patch output; readiness blockers suppress timeout/threshold
loosening; and Tune neither retains a second artifact nor imports a Control
execution API. The 118/118 focused baseline and shared/app TypeScript checks
pass at clean head `20e1df5`.

This was an implementation-start checkpoint, not parity or cutover evidence.
The completed evidence is recorded immediately below.

#### Iteration 7 timing/tuning exit — `cc17169`, `382df72`

Shared-test now owns additive snapshot performance, exact recursive tuning-knob
inventory, clone-only validated JSON Patch/diff output, readiness-first hints,
and selected performance deltas. The lazy Tune workspace consumes those
results from the retained Analyze artifact and root control query, has no seed,
poller, mutation API, or second artifact store, and unmounts while inactive.
Explicit comparison restores through existing v1 `compareLeft`, `compareRight`,
and `timingMetric` state. Candidate state follows source identity/support/knob
truth rather than routine snapshot timestamps.

The canonical timing, comparison, and no-mutation acceptances pass. Fresh exit
validation is 247/247 focused Vitest tests; a qualified-green 883-test app suite
across 93 files, with the sandbox's two denied IPC/loopback cases passing 9/9
under required permission; shared-test TypeScript plus all seven Deno entries;
app TypeScript; a 580-module build; reciprocal experience-chunk proof; 137
available Recipe Console Chromium tests with one exact configured-live skip;
12/12 Tune, 58/58 focused browser-matrix, 7/7 chunk, 28/28 preserved legacy
navigation/ticket, and 57/57 control-server tests. Four independent review
tracks end with no Critical or Important finding. The approved Direction A
short-landscape baseline was refreshed only after semantic and geometry gates
passed.

The in-app Browser was unavailable exactly as `No browser is available`;
controlled Playwright/System Chromium is fallback evidence. The configured
live/Postgres acceptance remains skipped, not passed, because: `Set
RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
apps/rallar-black-box-control-server, and apps/rallar-black-box available.`

Ready-State #7 and the bounded comparison plane for #8 are code-backed.
Ready-State #9 and Iteration 8 history/saved-filter/retention coverage remain
open. `runner.runs`, `runner.compare`, and `legacy.distributed-recipes` remain
visible, deep-linkable, and uncut. Exact rollback is
`/?workspace=black-box-runner&tab=runs` for `runner.runs`/`runner.compare` and
`/?workspace=black-box-runner&tab=distributed-recipes` for
`legacy.distributed-recipes`.

#### Iteration 8 history/retention implementation start — 2026-07-12

The reviewed tests-first
[implementation plan](../docs/superpowers/plans/2026-07-12-rallar-recipe-console-history-retention-implementation-plan.md)
binds Iteration 8 to existing control-server contracts and shared deterministic
history filtering. The new History UI is authorization-first and always
previews before confirmation; the existing omitted-preview-query
`POST /retention/cleanup` remains destructive and unchanged. A server-derived
dry-run preview returns a short-lived consequence
fingerprint bound to the server process and full secret-free deletion state,
explicit confirmation must match that exact preview, any run-set, issued-token,
process, expiry, or policy drift returns conflict and invalidates confirmation,
and malformed or unauthorized requests reveal no retention consequence. A 409
leaves the old preview visibly stale and requires a fresh preview before
confirmation.

History remains a bounded owner under `src/recipe-console/history/**` composed
into the lazy Tune route. No local-storage artifact bytes, silent comparison
selection, invented previous run, control-protocol break, or legacy cutover is
permitted. Its additive `historyRecipeId` filter stays distinct from the
cross-view operational `recipeId`, and retention client/validation code remains
inside the lazy History boundary. Ready-State #9 stays open until copied-URL restoration passes with
selected view, run, filters, comparison, and timing metric; all legacy Runs,
Compare, Distributed Recipes, and Run Manager fallbacks remain operational.

Task 0 baseline is green: 194/194 focused unit tests, control-server check and
57/57 tests, shared TypeScript plus seven Deno entries, app TypeScript, a
580-module build, reciprocal chunks, and 9/9 available History browser tests.
The configured-live owner was discovered and skipped, not passed, for the
unchanged required-service reason recorded below.

Task 1 is green through `07564df`. Additive shared-test owners derive a bounded
stable deletion plan from passive control/distributed/fleet truth. The server's
new query, HMAC-token, and cleanup adapters authorize first, never read request
bodies, preview without mutation, and require a fresh synchronous consequence
match after async token verification. Same-timestamp hidden/token state uses
safe monotonic revisions; raw run-token values are never exposed. Preview
bounds return `413`, guarded drift/expiry/process mismatch returns uniform
`409`, and bare/automatic legacy pruning remains unbounded with its exact
three-field response and socket/artifact semantics.

Fresh proof is 31/31 focused shared tests, the complete shared TypeScript plus
seven-entry Deno check, app TypeScript, server check, and 79/79 real-loopback
server tests. Real HTTP coverage includes nonempty linked distributed/fleet
consequences, authorization-first malformed/duplicate/overlong queries, an
issued token that does not authorize, wrong-process/tamper/reuse conflicts,
malformed ignored bodies, exact response whitelists, manual artifact survival,
and automatic registered-socket/artifact deletion. Final independent reviews
report no Critical or Important issue. No Recipe Console UI, legacy visibility,
deep link, rollback, or cutover changed in Task 1.

Task 2 is green through `7197beb`. The existing public manager error export now
re-exports one tiny canonical constructor, and 401/403 retry identity remains
compatible. A generic authorized endpoint owns credential injection and a
shared preview/confirm challenge while the lazy feature receives no raw token.
The provider exposes only a redacted context, opaque generation, and abort
signal; layout-lifecycle replacement, StrictMode replay, stale import/response,
cross-context preview, confirm/preview concurrency, and transient chunk retry
are explicitly covered. Exact immutable validators use shared types and
cumulative limits with linear consequence reconciliation.

Fresh proof is 59/59 retention-client tests, 70/70 existing manager/control-API
tests, 23/23 structure/build-boundary tests, app TypeScript, a 590-module build,
and the experience-chunk assertion. The 9.94 kB (3.39 kB gzip) retention client
is a separate dynamic entry; its request/validation sentinels are absent from
main, eager Recipe Console, and inactive Tune static closures. Final independent
review reports no Critical or Important issue. This client milestone adds no
History UI, hide, cutover, default, deep-link, or control-server-contract change.

Task 3 filter and URL code is green through `48b2fd0`. The shared filter matches
semantic categories through the existing explanation classifier over actual
run and rollup failures only, never the synthetic nonterminal readiness advice;
all legacy raw filters, inclusive dates, substring behavior, and stable ordering
remain intact. Malformed manifest fields become absent evidence while original
recipe fallback indices remain stable. The v1 codec adds `historyGroup`,
`historyRecipeId`, `historyProfile`, and a typed `failureCategory` without
overloading operational `recipeId` or clearing comparison/timing/unknown state.

Fresh proof is 78/78 focused tests, shared TypeScript plus all seven Deno entries,
app TypeScript, and independent review with no implementation defect. The
combined filter → Candidate → cleanup → copied URL/back-forward proof is still
open for Task 5 reconciliation.

Task 4 saved-filter persistence is green through `1e19dfb`. One injected,
versioned adapter stores only the eight committed History filters, with exact
whitelisting, deterministic duplicate/eviction behavior, 12/64/512/256 caps,
defensive raw/direct input limits, strict malformed-object rejection, and
future-version preservation. Browser `localStorage` is referenced only by the
focused hook; selections, comparison, credentials, artifacts, transient drafts,
and active-preset state cannot serialize. Loaded presets remain inert until an
operator applies one, so explicit URL state stays authoritative.

Fresh proof is 22/22 focused tests and app TypeScript. Review first exposed and
tests reproduced React replayable-updater writes and stale model carry-over when
the injected storage port changes. Writes are now outside functional updaters
and replacement ports are read before interaction. Final independent re-review
reports no Critical or Important issue. No UI, legacy visibility, mount policy,
deep link, rollback, default, or control contract changed.

Task 5 History projection and cleanup reconciliation are green through
`13070af` and `caa3980`. Root query snapshots retain root/fallback/unavailable
provenance through stale failures. The pure model applies the canonical shared
filter/order across the full server collection for exact counts, then limits
identity/manifest projection to 100 visible rows without deriving Tune
performance. Unsafe, duplicate, malformed, missing, and ambiguous identities
remain visible but cannot navigate; exact retention candidates keep generated
keys and unsanitized consequence truth.

Baseline/Candidate actions reuse Tune's safe patches. Cleanup uses captured
pre-cleanup associations to clear only deleted focus/dependent/comparison URL
fields while filters, timing, unknown state, newer valid selections, copied
links, and back/forward behavior remain stable. Fresh proof is 176/176 related
tests, full shared TypeScript plus seven Deno entries, app TypeScript, and final
review with no open Critical or Important issue. Async refresh-before-replace is
still reserved for the Task 7 hook; no History UI or legacy cutover is claimed.

Task 6 History UI is green through `055c96f`. A focused inspection hook keeps
`TuneWorkspace` at 139 lines, and exactly one 176-line History workspace follows
the current Tune evidence inside its existing lazy closure. The root passes
only query/navigation/copy seams and owns no History state. Signal Ledger
filters, presets, source/freshness labels, exact counts, full-ID table rows,
safe comparison actions, copy link, legacy handoff, and operational states are
visible without hover-only evidence or a new view.

Filters collapse 4→2→1 columns, the table owns horizontal overflow, and Tune
owns short-landscape vertical scrolling. Valid safe epochs beyond Date's
display range degrade to exact milliseconds. Fresh proof is 103/103 focused
History/Tune/build-boundary tests, 63/63 broader structure tests, app TypeScript,
and final review with no open Critical or Important issue after exact-ID action
labels closed an accessibility finding. Task 8 retains real-browser proof; no
legacy visibility, mount, route, default, or control contract changed.

Task 7 guarded retention UI is green through `7256379`. The History retention
owner loads the credential-safe client only on Preview, retains the raw opaque
plan solely in memory, and projects exact token-free control/distributed/fleet
consequences into a preview-first confirmation flow. Current/projected/cap
counts, connected agents, issued-token counts, linked run states, and unchanged
socket/artifact consequences remain visible. Exact server IDs preserve
whitespace and are isolated from bidi reordering without URL sanitization.

StrictMode, endpoint, API-base, credential-origin, connection-generation,
authorization, credential-trust, stale response, and post-confirm refresh
changes abort/invalidate before stale confirmation or URL reconciliation. The
dialog traps focus, starts on Keep history, supports Escape/backdrop cancel,
prevents double submit, restores Preview focus, and keeps `409` evidence stale
and nonconfirmable. Success refreshes root truth before clearing only selections
associated with actual deletions. Fresh proof is 121/121 focused tests, app
TypeScript, a 616-module build, reciprocal chunk proof, and three independent
clean re-reviews. Task 8 still owns every real-browser acceptance claim. No
legacy visibility, mount, route, rollback, default, cutover, public export, or
existing control-server contract changed.

#### Iteration 8 qualified exit — 2026-07-13

Task 8 canonical browser acceptance is code-backed in `fd9055e`; the approved
short-landscape Tune baseline, refreshed only for History's required internal
scroller reservation, is recorded in `f762749`. The exact copied-URL test now
restores the selected view, operational run, all eight History filters,
comparison pair, and timing metric. The exact retention test proves
authorization-first preview, token-free consequences, explicit confirmation,
refresh-before-selective URL reconciliation, actual deletion, post-confirm
token absence, copied link, reset, and back/forward behavior. Cancel, drift,
authorization, long-list keyboard scrolling, four contract viewports, coarse
targets, reduced motion, CSS load order, and lazy/unmounted boundaries are
executable acceptance rather than documentation claims.

Fresh exit proof passed 330/330 focused tests; shared-test TypeScript and all
seven Deno entries; 1,066/1,066 app tests across 106 files after the identical
restricted-sandbox command's two `listen EPERM` cases were rerun with required
permission; app TypeScript; a 616-module build; the static experience/retention
chunk assertion; control-server check and 79/79 Deno tests; 147 passed Recipe
Console browser cases with one configured-live skip; and 28/28 preserved legacy
tabbed-navigation/agent-ticket cases. Three Task 8 re-review tracks and the
final native-size visual re-review report no remaining Critical or Important
issue. The in-app Browser additionally confirmed offline desktop Execute and
portrait/landscape Tune containment with no warning/error logs.

The configured live/Postgres lifecycle is **skipped, not passed**, for exactly:
`Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
apps/rallar-black-box-control-server, and apps/rallar-black-box available.`
Ready-State #8 and #9 are code-backed; Ready-State #3 remains open. The existing
large legacy-chunk advisory, Node 26 versus CI Node 24 variance, and
`module.register()` deprecation warning remain explicit non-failing risks. No
legacy surface was hidden, no mount policy or rollback route changed, the
default remains legacy, existing public exports/control contracts remain
compatible, and nothing was pushed or opened as a PR.

#### Iteration 2 visual approval checkpoint — 2026-07-11

- The user approved Direction A, **Signal Ledger**, after reviewing desktop
  Execute, desktop failed Monitor, portrait Monitor, and short-landscape Tune
  concepts. The native concept files live under
  `apps/rallar-black-box/docs/recipe-console-concepts/**`.
- The approved implementation contract is
  `docs/superpowers/specs/2026-07-11-rallar-recipe-console-signal-ledger-design.md`.
  Concepts govern hierarchy, density, palette, typography, geometry, states,
  and responsive transformation; repository fixtures and deterministic
  derivations govern displayed recipe/run/evidence data.
- The implementation keeps blank and old-alias URLs on the legacy experience,
  accepts the explicit `experience=recipe-console` migration switch, emits
  canonical `v=1` links, and mounts Recipe Console and Legacy Experience as
  mutually exclusive lazy chunks.
- This checkpoint approves direction only. It does not prove the Iteration 2
  runtime, fidelity, accessibility, CSS-isolation, or chunk exit criteria and
  does not cut over or hide any legacy surface.

#### Iteration 2 exit checkpoint — `a397642`

- The explicit `experience=recipe-console` path now mounts the bounded
  180-line `RecipeConsoleApp` through a separate lazy experience closure;
  blank, old-alias, and explicit legacy URLs still mount only the preserved
  legacy experience. `App.tsx` remains 225 lines of auth/bootstrap/experience
  routing glue.
- The typed `v=1` codec, canonical replace/push behavior, safe unknown-field
  preservation, sensitive query/hash scrubbing, exact legacy-popstate
  preservation, and six-view back/forward restoration have executable proof.
- Execute, failed Monitor, Analyze, Tune, Fleet, and Advanced render from
  deterministic repository-backed seeds without services. Alternative recipe
  selection derives its own command truth and cannot reuse or enable an
  unmatched target preview. Refresh resets seeded workspace state; Export emits
  deterministic `preview: true` / `live: false` JSON. No UI claims live control
  connectivity or live execution.
- Desktop, 430×932 portrait, 900px tablet, and 932×430 short landscape pass
  geometry, overflow, touch, keyboard, focus trap/restore, reduced-motion,
  stale/error/empty, and one-inspector checks. Four controlled-Darwin pixel
  baselines use a 1% drift budget and were compared at original detail with the
  four approved native concepts. Repository-truth copy deviations are recorded
  in the [Iteration 2 fidelity ledger](../apps/rallar-black-box/docs/recipe-console-iteration-2-fidelity-ledger.md).
- In-app Browser QA was attempted first and was unavailable exactly as
  `Browser is not available: iab`; discovery returned `[]`. System Chrome
  fallback completed every target flow with clean canonical-page console and
  document health. Both CSS load-order captures were byte-identical, and
  Recipe Console/legacy round trips retained isolated computed styles.
- Fresh final validation after the last review fix passed 81/81 focused tests,
  typecheck, the 442-module production build, chunk-closure assertion, 40/40
  Recipe Console Chromium tests, 28/28 legacy navigation/ticket tests, and
  460/460 complete `packages/tests/rallar-black-box` tests. The Recipe Console
  JS/CSS are 47.31/25.37 kB minified; the preserved lazy LegacyExperience JS
  remains 780.37 kB and owns the known >500 kB advisory.
- Whole-iteration review initially found five Important issues, and the exit
  audit later found one selection-correlation leak. Focused RED/GREEN fixes
  closed all six plus the native-button semantic and favicon console-health
  findings. Final independent re-review found no Critical or Important issue.
  One minor possible one-render Execute context transition remains documented
  in the fidelity ledger.
- Live/Postgres coverage was skipped, not passed, for this exact reason:
  `Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
  apps/rallar-black-box-control-server, and apps/rallar-black-box available.`
  Iterations 3–12 remain pending; every migration-register row remains uncut.

| Iteration 2 exit criterion | Code-backed evidence |
| --- | --- |
| Seeded shell renders without a backend | 40/40 Recipe Console browser tests include repository-backed Execute/Monitor/Tune and bounded Analyze/Fleet/Advanced with zero control requests. |
| Legacy runner surfaces remain reachable | Blank, old aliases, explicit legacy links, exact popstate URLs, 28/28 legacy browser tests, and mutually exclusive mount checks pass. |
| Visually distinct with no CSS leakage | Scoped tokens/reset, CSS Modules, both load orders, navigation round trip, byte-identical isolation screenshots, and representative computed-style equality pass. |
| No broad legacy selector dependency | Structure tests lock scoped selectors/modules and reject legacy imports or broad new-system selectors. |
| Approved concepts have no unexplained drift | Four 1440×900 / 430×932 / 932×430 baselines pass at 1%; the fidelity ledger explains every repository-truth and population difference. |
| Default Recipe Console chunk excludes all legacy diagnostics | Production manifest/resource closure proves reciprocal hashed JS/CSS chunks; explicit Recipe Console requests no LegacyExperience or fixture resource. |

#### Iteration 3 control connection and agent board exit — `a7df46f`

- Recipe Console now owns a root-scoped, serialized control query that reads
  the canonical bounded `GET /runs` client, falls back to the compatibility
  distributed-run list only when the optional collection is absent, and
  preserves last-good evidence across partial, stale, offline, authorization,
  timeout, and recovery transitions. Polling is deduplicated, abortable, and
  stops when the Recipe Console experience unmounts. Successful HTTP payloads
  are deeply validated before repository derivation, including nested field
  types and unique control-run, distributed-run, and agent identities;
  malformed core snapshots remain reachable protocol failures and malformed
  optional distributed context degrades to a truthful partial snapshot.
- The top command bar reports reachability, authorization, control run, group,
  connected agents, current-safe targets, active distributed run, and client
  receipt time. Execute renders only repository-derived agent rows and blocker
  reasons. Stale rows are explicitly last-known, every current-safe count is
  zero, and unavailable URL IDs remain visible instead of selecting collection
  index zero or seeded data.
- Run and agent selection push typed v1 history, reload/copy/back/forward
  restore them, and run changes clear incompatible dependent fields.
  Deployment-configured endpoints may use configured manual or brokered
  credentials. A URL-selected control endpoint receives only an anonymous
  request unless the same incoming URL explicitly supplied `controlToken`;
  ambient configured tokens and token brokering are withheld. A URL-selected
  API endpoint never receives the stored auth session and cannot auto-consume
  an agent-session ticket. The incoming provenance is captured before Recipe
  Console synchronously scrubs sensitive query/hash fields ahead of either the
  login gate or lazy experience request. Legacy and `mode=control`
  runner-agent links retain their existing ticket behavior. After bootstrap,
  tokens remain memory-only.
- `App.tsx` is 260 lines of auth/bootstrap/experience glue,
  `RecipeConsoleApp.tsx` is 33 lines, and the focused workspace is 195 lines.
  The control service lives above the keyed preview workspace, so preview reset
  does not duplicate or discard control polling. No legacy panel, legacy owner,
  existing legacy mount policy, replacement registry, global stylesheet,
  endpoint, default route, primary navigation, rollback URL, hide, or workflow
  cutover changed. No existing export was removed, renamed, or made
  incompatible; the additive `ControlRunManagerHttpError` and
  `RecipeConsoleControlProtocolError` exports preserve message compatibility
  without changing the server protocol.
- Fresh exit validation passed the exact 155/155 ten-file focused unit slice,
  567/567 complete app tests across 62 files outside the socket-restricted
  sandbox, app typecheck and a 458-module production build, reciprocal
  experience chunk proof, 64/64 Recipe Console Chromium tests, 28/28 preserved
  legacy navigation/ticket tests, and
  control-server check plus 57/57 tests. Shared-test TypeScript and the same
  seven Deno entry checks passed; the Deno half used
  `--node-modules-dir=none` because the isolated worktree's sparse local
  `node_modules` cannot satisfy the root `nodeModulesDir: manual` lookup for
  the parent checkout's installed `@types/node`.
- Browser proof covers live, heartbeat-stale, offline-agent, wrong-group,
  missing-identity, partial, stale-last-good, recovered, offline,
  authorization-required, credential-trust-required, live-empty,
  unavailable-ID, malformed-core, malformed-optional-context, and duplicate
  identity states; stored-credential withholding from URL-selected origins;
  pre-lazy secret scrubbing; and ticket blocking for URL-selected API origins.
  Desktop, tablet, 430×932 portrait, 932×430 landscape, keyboard-only run/agent
  selection, 44px control targets, reduced motion, status announcements,
  overflow, CSS load order, and zero requests after an elapsed poll interval
  across the legacy unmount pass. The independently reviewed 4% Execute
  baseline delta is confined to the intentional control context and overview.
  The in-app Browser remained unavailable exactly as `Browser is not available:
  iab`; discovery returned `[]`, so controlled Playwright/System Chrome is the
  recorded fallback rather than an in-app Browser pass. Independent final
  code/contract and browser/validation review found no Critical or Important
  issue.
- The reproducible non-mutating standard-harness command
  `RALLAR_BLACK_BOX_LOCAL_CONTROL_SMOKE=1 npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/control-foundation-local-smoke.spec.ts`
  passed 1/1 against the actual local control process and observed a successful
  bounded `GET /runs`. This read and the Deno contract suite are not lifecycle
  evidence. At the Iteration 3 checkpoint the canonical
  `recipe-console-execute.spec.ts` configured-lifecycle acceptance file was
  absent and remained owned by Iterations 4–5. The configured
  Postgres-backed distributed lifecycle is **skipped, not passed**, for exactly:
  `Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
  apps/rallar-black-box-control-server, and apps/rallar-black-box available.`
  Ready-State #3 therefore remained open for visible create, stage, start,
  monitor, cancel, and export work in Iterations 4–5 plus that configured
  lifecycle proof. Iteration 4 now supplies the acceptance and visible Execute
  controls; the live Monitor, distinct live-cancellation, and configured-service
  gaps are recorded in its exit checkpoint below.

| Iteration 3 exit criterion | Code-backed evidence |
| --- | --- |
| A user can tell whether the control server is reachable and which agents are safe before selecting a recipe | The announced command status distinguishes reachable authorization/control errors from unreachable offline state; the first Execute region lists canonical control context, current-safe count, and every repository-derived targetability reason. Live, partial, stale, offline, recovery, wrong-group, missing-identity, unavailable-ID, keyboard, touch, responsive, and actual local-control read proofs pass. |

#### Iteration 4 exit checkpoint — `8d44a99`, `bddde71`

- The explicit Recipe Console Execute route now owns repository catalog/profile
  selection, recipe-aware targets, preflight, read-only manifest, authoritative
  status, and guided Resolve/Create/Stage/Start/Cancel/Refresh/schema-v2 Export.
  The seeded preview plane and duplicate generic agent board are removed. Pure
  recipe/run truth stays outside React, shared reusable catalog/manifest/target
  derivation lives in `packages/shared-test/**`, and raw transport ownership
  remains at the root control boundary.
- Credential origin is captured across initial legacy-to-Recipe history
  transitions. URL-selected endpoints cannot consume ambient manual, session,
  or brokered credentials, and runtime policy omission fails closed. All
  mutations reject stale post-await responses, target drift refuses Stage,
  post-mutation Refresh is ordered after pending reads, fresh reruns receive new
  identities, and reachable protocol, authorization, credential-trust, stale,
  partial, and offline states remain distinct.
- Fresh exit validation passed 294/294 focused tests across 18 files, 656/656
  complete app tests across 67 files, shared-test and app typechecks, a
  479-module build, reciprocal experience-chunk proof, 89 Recipe Console
  Chromium tests with one configured-live skip, 28/28 exact legacy
  navigation/ticket tests, and control-server check plus 57/57 Deno tests.
- Desktop, tablet, 430×932 portrait, 932×430 landscape, keyboard-only paths,
  44px targets, reduced motion, focus trap/restore, scrolling containment,
  operational announcements, and actual Execute CSS in both load orders pass.
  The refreshed Direction A Execute baseline was inspected at original detail.
  The in-app Browser was unavailable exactly as `No browser is available`, so
  controlled Playwright/System Chromium is fallback evidence, not an in-app
  Browser pass.
- Independent code/contract and browser/cutover reviews found one Critical and
  twelve Important issues across their passes. Every finding received focused
  RED/GREEN coverage, mutation proof where applicable, and the fresh exit rerun;
  no Critical or Important Iteration 4 finding remains open.
- The configured Postgres-backed lifecycle is **skipped, not passed**, for
  exactly: `Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
  apps/rallar-black-box-control-server, and apps/rallar-black-box available.`
  The configured test now uses authenticated `browser-rallar` agents and checks
  the exported artifact. Live Monitor observation and a distinct live
  cancellation remain Iteration 5 work. Ready-State #2 is satisfied; #3 remains
  open.
- `runner.recipes` still owns agent setup, readiness, and local launch, while
  `legacy.distributed-recipes` still owns Monitor, history, compare,
  diagnostics, and authoring. Both legacy rows remain visible, deep-linkable,
  mounted by their preserved policies, and uncut with unchanged rollback URLs.

#### Iteration 5 Monitor exit checkpoint — `46ea153` through `42eedae`

- The synthetic Monitor is replaced by a bounded live workspace that consumes
  the root control query and shared deterministic recipe/run evidence. It keeps
  role-scoped progress, selected-failure correlations, complete/partial/current
  truth, and context-keyed last-known evidence coherent without introducing a
  second poller, direct transport ownership, or React-side runner derivation.
  The first region states outcome, affected identity, and next inspection;
  failures precede bounded timeline/event/composite evidence.
- Visible Refresh, exact-context armed Cancel, Load artifact, and Export
  artifact actions use the existing credential-aware execution adapter. Cancel
  is blocked for partial, stale, offline, authorization, credential-trust, and
  terminal truth; successful mutations project immediately and queue the root
  refresh. Artifact identity, same-run retention, late abort-resistant
  responses, explicit run selection, URL restoration, and the exact legacy Runs
  handoff have executable proof.
- Fresh exit validation passed the exact 229/229 focused unit slice, 708/708
  complete app tests across 72 files, shared-test and app TypeScript checks, the
  507-module production build and reciprocal experience-chunk assertion, 100
  Recipe Console Chromium tests with one configured-live skip, 28/28 preserved
  legacy navigation/ticket tests, and control-server check plus 57/57 tests. A
  no-environment run of the full-stack Monitor wrapper produced exactly one
  skipped test with the required reason.
- Desktop, tablet, 430×932 portrait, 932×430 landscape, keyboard-only paths,
  44px targets, focus trap/restore, reduced motion, operational transitions and
  announcements, contained scrolling, CSS isolation in both load orders, and
  refreshed Direction A Monitor baselines pass through controlled
  Playwright/System Chromium. The in-app Browser was unavailable exactly as
  `No browser is available`; this is fallback evidence, not an in-app Browser
  pass.
- Seven Task 5 Important proof/safety findings—configured contract failures
  misclassified as skips, possible memory-API reuse, mobile visual/DOM action
  order, wrong-run legacy handoff, fixture-authored reconnect prose,
  short-landscape Monitor overflow, and the missing keyboard-only Monitor
  path—were closed with focused RED/GREEN coverage. Final independent
  code/contract and browser/cutover review found no open Critical or Important
  issue.
- Ready-State #4 and #5 are code-backed and satisfied by the exact Monitor
  acceptance owners. The configured Postgres-backed lifecycle in
  `tests/playwright/rallar-black-box/full-stack-recipe-console-monitor.spec.ts`
  is discovered by the canonical command and checks visible Monitor truth,
  artifact export, distinct non-terminal cancellation, and per-target
  dispatched/completed `recipe.cancel` commands, but the services were
  unavailable. It is therefore **skipped, not passed**, for exactly:
  `Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
  apps/rallar-black-box-control-server, and apps/rallar-black-box available.`
  Ready-State #3 remains open and unpassed.
- There is no default, primary-navigation, hide, unmount, or cutover change.
  `runner.runs` remains visible and owns history, offline import/analysis,
  comparison, and local-run work; `legacy.distributed-recipes` remains visible
  and owns history, comparison, diagnostics, and authoring. Iterations 6–12
  retain artifact import, tuning/compare, scale, Fleet, Advanced, final
  accessibility, configured-live, and default-flip risks.

| Iteration 5 exit criterion | Code-backed evidence |
| --- | --- |
| A running or failed run is understandable from the first visible region | The live verdict exposes outcome, affected identity, next inspection, provenance, and bounded warning truth; failure-first ordering passes the exact Ready-State #4 acceptance. |
| Available failure correlations are operable and last-known evidence remains honest | Agent, recipe, command, diagnostic, timeline/event, and artifact destinations pass the exact Ready-State #5 acceptance; refresh failure, recovery, deletion, context change, and copied-link restoration remain explicit. |
| Monitor actions use current authoritative control truth | Policy/unit and browser proofs cover Refresh, armed Cancel, Load/Export, stale/partial/offline blocking, identity checks, mutation projection, queued refresh, and abort-resistant late responses. |
| The strangler boundary remains reversible | Both legacy workflow rows, aliases, deep links, rollback URLs, and mount policies remain operational; the new legacy Runs link restores the exact selected two-run context. |

#### Iteration 6 artifact analysis exit — `f96b5b4`, `abe257e`, `9b07330`, `47c332d`

- Shared-test now owns additive distributed-artifact workspace normalization,
  the authoritative control-server schema-v2 profile, envelope/loose-file
  convergence, future/malformed/partial compatibility inventory, deterministic
  bounded evidence indexing/search, likely-causal issue output, and precise
  provenance. Existing public exports and control-server contracts remain
  compatible.
- Recipe Console replaces the static Analyze preview with bounded file/folder/
  drop intake, the existing credential-aware Control Load adapter, in-memory
  Export, failure-first verdict/fix, likely causal trail, file quality,
  performance, URL-backed search, issue Markdown, and one explicit contextual
  inspector. Artifact bytes stay in a root hook while inactive Analyze UI is
  unmounted; reload visibly requires re-import or Control Load.
- Intake is capped at 24 files, 16 MiB per file, and 48 MiB total. Duplicate or
  unsafe paths, unsafe/unbounded/malformed-Unicode identities, paired control/
  distributed mismatches, context-stale and late responses, malformed
  replacements, and concurrent local/control drops retain prior evidence and
  fail visibly. Generic black-box-runner artifacts stay a separate preserved
  Shared Test profile.
- The exact canonical offline acceptance passes without any artifact endpoint
  read. The complete Analyze matrix also proves loose/envelope round-trip,
  future schema and bounded-input behavior, search fields/time ranges,
  Control export/re-import without a second request, URL history/reload,
  unmount/remount persistence, legacy handoffs, desktop/tablet/430×932/
  932×430 layouts, keyboard/focus, 44px targets, reduced motion, announcements,
  zero horizontal overflow, and CSS isolation in both load orders.
- Fresh exit validation passes 226/226 focused tests across 15 files, 786/786
  complete app tests across 81 files, shared-test and app TypeScript checks, a
  551-module production build and experience-closure assertion, 119 available
  Recipe Console Chromium tests, 28/28 preserved legacy navigation/ticket
  tests, and 57/57 control-server Deno tests. One
  configured-live test is skipped, not passed, for the exact reason below.
  The in-app Browser was unavailable exactly as `No browser is available`, so
  Playwright/System Chromium is fallback evidence rather than an in-app
  Browser pass.
- Independent shared-contract review closed three Important findings. The
  final app/state audit closed six Important findings covering retained
  context, paired identity authority, URL/filename hardening, malformed
  Unicode, and truthful concurrent-operation announcements. Final re-reviews
  report no open Critical or Important issue.
- Ready-State #6 is code-backed. Ready-State #3 remains open because the
  Postgres-backed configured lifecycle is unavailable and **skipped, not
  passed**, for exactly: `Set RALLAR_BLACK_BOX_FULL_STACK=1 with
  Postgres-backed apps/api-v1, apps/rallar-black-box-control-server, and
  apps/rallar-black-box available.`
- No default, primary navigation, legacy visibility, legacy mount policy,
  public export, endpoint, or rollback route changed. `runner.runs`,
  `legacy.distributed-recipes`, `legacy.shared-test-import`, and
  `legacy.run-manager` retain the responsibilities outside this distributed-
  artifact cut.

| Iteration 6 exit criterion | Code-backed evidence |
| --- | --- |
| A CI artifact reveals the first actionable failure without raw JSON | The exact canonical offline acceptance passes with verdict, likely cause, next action, fix area, evidence file, affected identity, verification command, quality, performance, search, and issue Markdown. |
| Local and Control artifact operations are bounded and truthful | File limits, duplicate/path/identity hardening, generation/context authority, paired IDs, retained failures, Control Load, one-request Export, envelope re-import, reload clearing, and live announcements have unit/browser proof. |
| Analyze is responsive, accessible, and isolated | All four contract viewports, keyboard-only picker/evidence/inspector paths, focus restore/Escape, 44px targets, reduced motion, zero horizontal overflow, and both CSS load orders pass. |
| The strangler boundary remains reversible | Analyze unmounts inactive; loaded bytes remain bounded in the root hook; exact legacy Runs and Shared Test links pass; no legacy surface is hidden, re-homed, or removed. |

#### Iteration 1 checkpoint — `63e7b2c`

- The structure gate and module-boundary note are active. Extracted owners now
  cover the legacy distributed monitor/run manager/distributed recipes,
  advanced workbench/manual/shared-test/runner recipes/runner runs/flow builder/
  fleet surfaces, diagnostic evidence leaves, Quick Test, RTC Realtime, and the
  WebSocket deterministic/presentation seams.
- Every completed slice retained exact App mount, owning ancestor, JSX/runtime,
  controller/effect, and stylesheet parity where applicable. Focused tests,
  typecheck, builds, mutation probes, browser QA, and independent reviews are
  recorded per local milestone.
- No surface has been newly hidden, no default or URL behavior has flipped, and
  the documented mounted-state exceptions remain in force.
- `App.tsx` is 9,242 lines at this checkpoint. The WebSocket controller, other
  direct diagnostic surfaces, auth/bootstrap gates, and complete legacy tab
  composition remain; therefore the below-800-line/no-feature-panel exit is not
  yet satisfied.

#### Worktree recovery checkpoint — `5d86e17` (2026-07-11)

- The OS removed the original `/private/tmp` linked-worktree directory after
  W3 was committed. Git retained the complete branch and all milestone commits.
- The same `codex/rallar-black-box-spa-reimplementation` branch is now checked
  out at the repository's ignored, persistent
  `tmp/worktrees/rallar-black-box-spa` path; the main checkout remains clean.
- Recovery verification passed the five-file focused slice (65/65) and app
  typecheck at `5d86e17`. No unavailable live-service test is inferred from
  this recovery evidence.
- `App.tsx` is 8,012 lines after the exact WebSocket controller cutover. Media
  is the next tests-first extraction slice; Iteration 1 exit criteria remain
  unsatisfied.

#### Iteration 1 Media M1 checkpoint — `5df1cf2` (2026-07-11)

- The exact private Media surface moved to the direct focused owner
  `src/legacy/diagnostics/media/MediaConsolePanel.tsx` (457 lines), leaving
  `App.tsx` at 7,575 lines. Its mount, hidden-mounted stream/subscription
  lifetime, controller/effect/cleanup statements, actions, JSX/runtime,
  events, styles, deep link, and public/control-server surfaces remain
  unchanged. This is ownership movement only: no surface is cut over or hidden.
- Tests-first proof reconstructed the untouched-production RED at 42/43 with
  exactly the four intended extraction failures. Final focused verification
  passed 57/57, app typecheck and build passed, mutation probes caught
  declaration, cleanup, facade-action, and JSX-label drift, and independent
  review completed with no findings.
- Playwright passed the existing simulated Media guardrail (1/1) and a
  temporary extraction QA matrix (3/3) covering desktop, portrait, landscape,
  reduced motion, keyboard focus/navigation, direct/runner round trips,
  hidden-mounted single-instance/state retention, CSS adjacency/isolation,
  overflow, and browser errors. The in-app browser was unavailable after its
  runtime reset, so regular Playwright was the recorded fallback.
- The exhaustive Media live-service scenario was **skipped, not passed**, for
  this exact reason: `Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed
  apps/api-v1, apps/rallar-black-box-control-server, and
  apps/rallar-black-box available.`
- Landscape Media action controls measure 30px high under the preserved legacy
  stylesheet. That is not an extraction regression, but it remains explicit
  Iteration 12 debt against the eventual 44px touch-target gate.

#### Iteration 1 Rallar Data M1 checkpoint — `a328c25` (2026-07-11)

- The exact private Data types and complete panel moved to
  `src/legacy/diagnostics/rallar-data/RallarDataPanel.tsx` (670 lines), leaving
  `App.tsx` at 6,927 lines. `BrowserRallarFacade` remains App-local for CRDT.
  The Data store/change-listener owner, unsubscribe/store-close cleanup,
  30-operation dispatch, runtime topics, JSX, direct mount, hidden-mounted
  lifetime, stylesheet, aliases, public exports, and control contracts are
  unchanged. This is ownership movement only: no route is cut over or hidden.
- Untouched-production RED passed 43/44 with exactly the four intended
  ownership failures; all fallback semantics remained green. Final focused
  verification passed 58/58, the listed Iteration 1 validation slice passed
  77/77, typecheck/build passed, four independent mutation probes were caught,
  and two independent final reviews completed with no findings.
- The in-app Browser desktop check plus Playwright's simulated guardrail (1/1)
  and temporary reduced-motion desktop/portrait/landscape matrix (3/3) proved
  one owner, state retention across tab and workspace-mode round trips,
  keyboard navigation/focus, disabled real-backend guardrails, CSS isolation,
  zero document/panel overflow, and no browser errors. The temporary QA spec
  was removed.
- The exhaustive Data lifecycle scenario was **skipped, not passed**, for this
  exact reason: `Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed
  apps/api-v1, apps/rallar-black-box-control-server, and
  apps/rallar-black-box available.`
- Data action controls measure 30px at desktop and 932x430 landscape, and 44px
  at 430x932 portrait, under the unchanged legacy stylesheet. The 30px cases
  remain explicit Iteration 12 touch-target debt.

#### Iteration 1 Auth M1 checkpoint — `ab2536f` (2026-07-11)

- The exact Auth diagnostic panel moved to
  `src/legacy/diagnostics/auth/AuthCommandCenterPanel.tsx` (518 lines), with
  narrow recipe (53), shared REST action-log (30), and safe session-read (10)
  seams. `App.tsx` is 6,361 lines. LoginScreen, auth/bootstrap state, facade
  auth subscription, one-time ticket consume/dedupe/scrub, global-context
  synchronization, connecting/login gates, and logout orchestration remain in
  App. The hidden mount, drafts/history, actions, redaction, JSX, styles,
  aliases, public exports, and server contracts are unchanged.
- Untouched-production RED passed 44/45 with exactly six intended ownership
  failures while all fallback semantics remained green. Final combined focused
  and listed Iteration 1 validation passed 93/93; typecheck/build passed; four
  mutations were caught; and two independent final reviews completed with no
  findings.
- The in-app Browser check, simulated login/ticket/negative/redaction flow
  (1/1), and temporary reduced-motion desktop/portrait/landscape matrix (3/3)
  proved one owner, draft retention across tab/workspace round trips, keyboard
  focus, CSS isolation, zero overflow, and no browser errors. The temporary QA
  spec was removed.
- The exhaustive real-provider Auth/Groups flow was **skipped, not passed**,
  for this exact reason: `Set RALLAR_BLACK_BOX_FULL_STACK=1 with
  Postgres-backed apps/api-v1, apps/rallar-black-box-control-server, and
  apps/rallar-black-box available.`
- Auth action controls measure 42px at all three QA viewports under the
  unchanged stylesheet. This remains explicit Iteration 12 debt against the
  44px touch-target gate.

#### Iteration 1 Groups/Clients R1 checkpoint — `1332f60` (2026-07-11)

- The exact private action/sort/state contracts and constants moved to
  `src/legacy/diagnostics/rooms-clients/rooms-clients-contracts.ts` (216
  lines), deterministic snapshot/event normalization and sorting moved to
  `rooms-clients-derivations.ts` (292 lines), and the shared recursive string
  lookup moved to `diagnostics/shared/deep-string-value.ts` (32 lines).
  `App.tsx` is 5,848 lines. `BrowserRallarFacade`, the complete stateful
  `RoomsClientsPanel`, its request/direct actions, lifecycle, and its one
  hidden-mounted instance remain App-owned. Routes, CSS, public exports, and
  server contracts are unchanged; this is ownership movement only.
- Untouched-production RED passed 37/38 with exactly five intended soft
  ownership failures while every fallback fingerprint remained green. Final
  listed Iteration 1 validation passed 79/79 and the combined mode-boundary
  slice passed 87/87; typecheck/build passed (360 modules), four independent
  mutations were caught, and two independent reviews approved the move with no
  remaining findings.
- The in-app Browser inspection, preserved authenticated state/sort/filter
  flow, mobile usability guardrail (2/2), and temporary reduced-motion
  desktop/portrait/landscape matrix (3/3) proved one hidden-mounted owner,
  draft/filter retention, arrow-key selection, a visible 2px focus outline,
  CSS isolation, zero document overflow, and no browser errors. The temporary
  QA spec was removed.
- The exhaustive real Groups/Clients lifecycle was **skipped, not passed**, for
  this exact reason: `Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed
  apps/api-v1, apps/rallar-black-box-control-server, and
  apps/rallar-black-box available.`
- The matrix exposed existing tab behavior: arrow keys update selection, but
  focus does not follow the newly selected tab. The exact App-function hash
  proves this is not extraction drift; it remains explicit Iteration 12
  keyboard-accessibility debt.

#### Iteration 1 Groups/Clients R2 checkpoint — `a26ffdb` (2026-07-11)

- The 1,063-line stateful surface is now a focused four-owner composition:
  `rooms-clients-request.ts` (51 lines),
  `use-rooms-clients-controller.ts` (698), `RoomsClientsView.tsx` (534), and
  `RoomsClientsPanel.tsx` (17). `App.tsx` is 4,711 lines and imports only the
  thin root. The two request helpers, exact 44-statement controller, two memos,
  sixteen states, two synchronization effects, REST/direct actions, derived
  model, and legacy JSX moved without behavior changes. The App mount and
  hidden tab-section ancestor remain exact, so drafts, results, sorts, filters,
  and loaded state keep their documented hidden-mounted lifetime.
- Untouched-production RED passed 38/39 app-structure tests with exactly seven
  intended soft ownership failures while mode-boundary stayed green 8/8.
  Final combined validation passed 88/88; typecheck/build passed (364 modules),
  four independent mutations were caught, and two independent reviews
  approved the extraction with no findings. The pre-existing large-chunk
  warning remains (`index` 1,256.34 kB minified) for the later experience-route
  code-splitting cutover rather than being represented as resolved here.
- The in-app Browser inspection, preserved authenticated REST/direct-console
  flow plus mobile guardrail (2/2), and temporary reduced-motion
  desktop/portrait/landscape matrix (3/3) proved the exact DOM, one
  hidden-mounted owner, draft/filter retention, operational sorting/filtering,
  arrow-key selection, visible focus, CSS isolation, zero document overflow,
  and no browser errors. The temporary QA spec was removed.
- The exhaustive real Groups/Clients lifecycle was **skipped, not passed**, for
  this exact reason: `Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed
  apps/api-v1, apps/rallar-black-box-control-server, and
  apps/rallar-black-box available.`
- Preserved Rooms/Clients actions measure 42px at desktop, portrait, and
  landscape. Together with the unchanged focus-handoff behavior, this remains
  explicit Iteration 12 accessibility debt. No route, alias, public export,
  server contract, navigation visibility, or cutover status changed in R2.

#### Iteration 1 Rallar Server M1 checkpoint — `e2408f0` (2026-07-11)

- The complete Rallar Server workbench is now a six-owner composition under
  `src/legacy/diagnostics/rallar-server/**`: the request-feedback contract (14
  lines), collection parsers (34), feedback panel (84), exact controller
  (762), exact view (561), and thin root (18). `App.tsx` is 3,433 lines and
  imports only that root. The exact 55 controller statements, 25 state slots,
  seven memos, three effects, request/collection actions, redaction, runtime
  events, JSX, App mount, hidden ancestor, styles, and server contracts remain
  unchanged.
- Untouched-production RED passed 39/40 app-structure tests with exactly eight
  intended soft ownership failures while mode-boundary stayed green 8/8.
  Final listed Iteration 1 validation passed 107/107; typecheck/build passed
  (369 modules); six semantic mutation probes were caught; and two independent
  final reviews approved the extraction. The existing large-chunk warning
  remains (`index` 1,258.36 kB minified) for the later experience-route
  code-splitting cutover rather than being represented as resolved here.
- The in-app Browser inspection, four simulated Rallar Server flows plus the
  mobile guardrail (5/5), and temporary reduced-motion desktop/portrait/
  landscape matrix (3/3) proved success and failure feedback, collection
  assertions/extraction, redacted reload persistence, one hidden-mounted owner,
  state retention, keyboard selection, CSS isolation, zero document/panel
  overflow, and no browser errors. The temporary QA spec was removed.
- The two exhaustive Postgres scenarios were **skipped, not passed**, for this
  exact reason: `Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed
  apps/api-v1, apps/rallar-black-box-control-server, and
  apps/rallar-black-box available.` The four general full-stack scenarios were
  separately **skipped, not passed**, for this exact reason: `Set
  RALLAR_BLACK_BOX_FULL_STACK=1 and provide either Postgres env files or
  RALLAR_BLACK_BOX_API_MODE=memory for apps/api-v1 full-stack Rallar Black Box
  tests.`
- The hidden-mounted exception remains explicit for invalid editable JSON,
  OpenAPI presets, feedback, response and collection results, and busy/error
  state in addition to the redacted persisted drafts. Server action controls
  measure 42px at all three viewports, and arrow-key selection still does not
  transfer DOM focus. Both remain Iteration 12 accessibility debt. No route,
  alias, public export, server contract, navigation visibility, hide, mount,
  rollback, or cutover status changed in M1.

#### Iteration 1 CRDT M1 checkpoint — `0927c46` (2026-07-11)

- The complete CRDT editor and admin-health surface is now a seven-owner
  composition under `src/legacy/diagnostics/crdt/**`: contracts (37 lines),
  editor controller (343), board view (283), entities view (240), editor
  composition (302), health controller (297), and health panel (290).
  `App.tsx` is 1,849 lines and imports only `CrdtHealthPanel`. The exact
  44-statement editor controller, 27 states, two refs, cleanup effect, exact
  13-statement/five-state health controller, actions, redaction, JSX, nested
  editor mount, App mount, hidden ancestor, and stylesheet remain unchanged.
- Untouched-production RED passed 40/41 app-structure tests with exactly nine
  intended soft ownership failures while mode-boundary stayed green 8/8.
  Final listed Iteration 1 validation passed 100/100; typecheck/build passed
  (375 modules); five semantic mutation probes caught cleanup, transport-guard,
  board-action, admin-route, and nested-mount drift; and two independent
  reviews approved the extraction. The existing large-chunk warning remains
  (`index` 1,260.69 kB minified) for the later experience-route code-splitting
  cutover rather than being represented as resolved here.
- The in-app Browser operational check and temporary reduced-motion desktop,
  430x932 portrait, and 932x430 landscape matrix (3/3) proved local document
  open/close, board/entity mutations, diagnostics, state retention across
  hidden-tab round trips, keyboard tab selection, one mounted owner, CSS
  isolation, and no browser or page errors. The temporary QA spec was removed.
  The matrix also quantified unchanged legacy layout debt: the portrait
  document is 807px wide because the entity form, diagnostics, and admin table
  lack narrow-screen containment; desktop and landscape CRDT actions are 30px
  high while portrait actions are 44px. Both corrections belong to Iteration
  12 and are not represented as extraction regressions or passing ready-state
  accessibility evidence.
- The exhaustive CRDT scenario was **skipped, not passed**, for this exact
  reason: `Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
  apps/rallar-black-box-control-server, and apps/rallar-black-box available.`
- The hidden-mounted exception remains explicit for all transient editor
  inputs/results, the active document and subscription, and the health panel's
  five state slots: busy action, error, document list, selected document key,
  and last result. Arrow-key selection still does not transfer DOM focus. No
  route, alias, public export, server contract, navigation visibility, hide,
  mount, rollback, or cutover status changed in M1.

#### Iteration 1 legacy shell leaves L1 checkpoint — `12c0ea2` (2026-07-11)

- Seven focused legacy shell owners now hold the exact login screen (149
  lines), run header (203), tabs (58), global context bar (112), mode switch
  (35), direct-operation boundary (210), and runner boundary (29).
  `App.tsx` is 1,065 lines and retains the exact 833-line App function; stale
  moved-owner imports were removed. No aggregate shell-leaf module, App
  back-edge, style owner, route change, mount change, or lazy-unmount cutover
  was introduced.
- The untouched-production shell gate failed only its 21 intended missing
  owner/import/stale-declaration assertions while the prior structure/mode
  slice stayed green 49/49. The final focused shell validation passed 75/75;
  typecheck/build passed (382 modules); five mutation probes caught runner
  guard, arrow direction, direct telemetry, App mount guard, and unexpected
  top-level state drift; and independent final review approved the slice. The
  strengthened gate locks exact component AST, import symbols/aliases/type
  kinds, export/top-level inventory, local hook topology, transitive local
  acyclicity, App AST, and stylesheet parity. The existing main-chunk warning
  remains (`index` 1,260.69 kB minified).
- Existing desktop/portrait shell flows passed 3/3. A temporary reduced-motion
  desktop, 430x932 portrait, and 932x430 landscape matrix passed 3/3 and proved
  header expansion, global-context editing and retention, arrow-key tab
  selection, both workspace boundaries, auth-gate isolation, mode round trips,
  CSS isolation, zero page overflow, and no browser/page errors. The temporary
  spec was removed.
- The two exhaustive authenticated shell scenarios were **skipped, not
  passed**, for this exact reason: `Set RALLAR_BLACK_BOX_FULL_STACK=1 with
  Postgres-backed apps/api-v1, apps/rallar-black-box-control-server, and
  apps/rallar-black-box available.`
- This is not the Iteration 1 exit: pure models and ticket helpers remain
  App-local, `App()` still owns eight state slots, eight effects, and the
  complete tab tree,
  `LegacyAppShell` does not yet exist, and the required below-800
  bootstrap/provider/routing boundary remains unsatisfied.

#### Iteration 1 legacy shell models M1 checkpoint — `0939161` (2026-07-11)

- Exact runner queue/selection derivation now lives in the 46-line
  `src/legacy/runner/shell/runner-shell-model.ts`; global-context derivation,
  equality, and bootstrap patching live in the 69-line
  `src/legacy/shell/global-context-model.ts`; and one-time agent-ticket URL
  scrubbing, in-flight deduplication, and cache release live in the 47-line
  `src/legacy/shell/auth/agent-session-ticket.ts`. `App.tsx` is 926 lines and
  retains the exact 833-line App function. No state slot, effect, render guard,
  mount, route, alias, default, stylesheet, public export, or control-server
  contract changed.
- The tests-first ownership gate began with the existing shell-leaf test green
  and exactly 19 intended model-owner/import/stale-declaration failures. It now
  locks exact moved AST, import symbols/aliases/type kinds, top-level inventory,
  local acyclicity, App removal/imports, App AST, and line caps. A separate
  seven-test behavior oracle covers all queue statuses, result fallback,
  global-context precedence and equality fields, bootstrap patching, fragment
  preservation, in-flight ticket deduplication, and cache release after both
  fulfillment and rejection.
- Final focused verification passed 100/100; typecheck/build passed (385
  modules), with the existing large-chunk warning still present (`index`
  1,261.06 kB minified). Five controlled mutations were caught for failed
  queue status, auth/config precedence, ticket scrubbing, ticket deduplication,
  and unexpected top-level state. Two independent reviews approved the slice.
- The focused Chromium ticket workflow passed 1/1, proving two popup agents
  consume distinct one-time tickets, receive fresh per-tab sessions, and scrub
  the fragment even when session storage is inherited. The exact App function
  and stylesheet locks keep the prior L1 desktop/portrait/landscape,
  keyboard, reduced-motion, operational-state, and CSS-isolation evidence
  applicable; no new visual or mount behavior was introduced.
- Exhaustive authenticated shell coverage remains unavailable and is **not
  represented as passed** for this exact harness reason: `Set
  RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
  apps/rallar-black-box-control-server, and apps/rallar-black-box available.`
  This is not the Iteration 1 exit: App still owns eight state slots, eight
  effects, navigation/global-context/selection orchestration, the complete tab
  tree, and the inline fleet share-link builder; `LegacyAppShell` does not yet
  exist and the below-800 boundary remains unsatisfied.

#### Iteration 1 fleet share-link M2 checkpoint — `ff79d28` (2026-07-11)

- Fleet share-link construction is now the pure
  `buildFleetShareUrl(...)` helper in
  `src/legacy/runner/fleet/fleet-helpers.ts`. The controller retains only the
  browser clipboard effect. Mode/tab targeting, filter and map-layer encoding,
  unrelated query parameters, query ordering, and fragment preservation remain
  exact; no URL codec, route, public export, or control-server contract changed.
- The focused behavior/structure gate passed 48/48, typecheck/build passed, and
  a controlled `fleet`-to-`runs` target mutation failed both the behavior and
  AST gates. The existing chunk warning remains (`index` 1,261.09 kB
  minified). This completes the Iteration 1 share-link-builder item but does
  not change App size, mounts, navigation, cutover, or the remaining shell
  controller/composition exit work.

#### Iteration 1 legacy shell controllers M3 checkpoint — `0ecade8` (2026-07-11)

- Navigation state, popstate lifetime, alias normalization, and URL writes now
  live in the 79-line `src/legacy/shell/use-legacy-navigation.ts` owner.
  Global-context defaults, edited/auth synchronization, browser status, and
  explicit bootstrap updates live in the 128-line
  `use-command-center-global-context.ts` owner. Runner queue/history/clock,
  selected command/result, distributed-run handoff state, late selection sync,
  and persistence live in the 75-line
  `src/legacy/runner/shell/use-runner-shell-state.ts` owner.
- The split preserves the authoritative effect order even while auth gates
  render: `useNow` interval, popstate, three auth effects, global sync,
  bootstrap activation, selection sync, and selected-ID persistence. App is
  now 759 lines with only three direct state slots, four direct effects, and no
  direct memo/ref; the transitive hook topology and complete JSX tree remain
  exact. The Iteration 1 below-800 checkpoint is therefore satisfied.
- Tests-first proof began with only the three intended missing-owner failures.
  The final 12-file focused slice passed 108/108; typecheck/build passed (388
  modules), with the existing large-chunk warning still present (`index`
  1,262.00 kB minified). Five controlled mutations caught missing URL writes,
  broken popstate cleanup, auth-merge drift, omitted edited-state marking, and
  a 250-to-500 ms clock change. Independent review approved the final restored
  state with no findings.
- Focused Chromium browser verification passed 28/28 across URL/default/deep
  links, runner/direct mode boundaries, operational panels, hidden-state
  retention, fresh-load persistence, two fresh agent sessions, and ticket
  fragment scrubbing. The exact JSX/style locks retain the prior reduced-motion
  desktop/portrait/landscape and CSS-isolation evidence because this slice
  moved controllers only.
- Exhaustive authenticated shell coverage remains unavailable and is **not
  represented as passed** for this exact harness reason: `Set
  RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
  apps/rallar-black-box-control-server, and apps/rallar-black-box available.`
  This is not the Iteration 1 exit: App still imports every feature panel and
  owns the complete 473-line legacy shell/tab JSX; focused tab groups and a
  thin `LegacyAppShell` remain mandatory.

#### Iteration 1 legacy shell composition M4 and exit — `9c173d8` (2026-07-11)

- `App.tsx` is now 234 lines and imports no feature panel. It retains the
  runtime/bootstrap subscription, the three auth gates/effects, shared
  navigation/global-context/runner-shell controllers, and one
  `LegacyAppShell` experience mount. The explicit module-boundary note still
  prevents Recipe Console feature work from returning to App.
- The exact legacy chrome and tab tree now live in the 119-line
  `LegacyAppShell`, the 49-line diagnostics drawer, a 28-line type-only shell
  contract, and six hook-free tab groups of 52–179 lines. The 24 section IDs,
  render order, ARIA links, six active-only guards, Topology activity signal,
  panel props, and 18 hidden-mounted lifetimes remain exact. No replacement
  registry, aggregate controller, global stylesheet, or shell monolith was
  introduced.
- Tests-first composition work began with the intended missing-owner/App
  failures. The documented Iteration 1 command passed 82/82; the complete
  `packages/tests/rallar-black-box` run passed 392/392 across 50 files;
  typecheck and the 396-module production build passed. The existing default
  chunk warning remains (`index` 1,264.61 kB minified) and is owned by the
  Iteration 2 separate-experience chunk proof.
- The strict AST gate locks exact imports and type/value kinds, top-level
  inventories, the acyclic App-to-shell DAG, direct group and section order,
  all hidden expressions, exact guarded subtrees, unconditional lifetimes,
  direct fragment children, App/auth topology, and the byte-identical legacy
  stylesheet. Six controlled mutation scenarios caught a group reorder, a
  composition cycle, a conditional stateful unmount, a DOM wrapper, corrupted
  Recipes/Topology guards, and an incorrect hidden expression; every mutation
  was restored before final verification. Two independent final reviews found
  no production or test-quality issue.
- Focused Chromium passed 28/28 URL/default/deep-link, operational,
  persistence, fresh-session, and one-time-ticket scenarios; the mobile
  portrait suite passed 1/1. Browser QA at 932x430 found zero document
  overflow, all 24 sections connected, and exactly one visible panel.
  Explicit reduced-motion emulation found no animated/transitioning legacy
  element, and keyboard selection still routes to the next tab. Its existing
  failure to transfer focus remains registered Iteration 12 debt.
- Exhaustive authenticated/live-service shell coverage was skipped and is
  **not represented as passed** for this exact harness reason: `Set
  RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
  apps/rallar-black-box-control-server, and apps/rallar-black-box available.`
  No legacy surface was hidden, unmounted, cut over, or removed from its old
  deep link in this exit slice.

| Iteration 1 exit criterion | Code-backed evidence |
| --- | --- |
| `App.tsx` is visibly thinner without UI changes | 28,265 → 234 lines; exact App/shell/panel AST and stylesheet locks; 28/28 focused Chromium plus portrait/landscape/reduced-motion QA. |
| App contains bootstrap/provider/experience routing only and declares no feature panel | Exact import/top-level inventory permits runtime, auth, controllers, login, and `LegacyAppShell` only; the App line cap is 280 and current size is 234. |
| No new Recipe Console panel may be added directly to App | The module-boundary comment remains in `App.tsx`, and the structure/composition gates reject feature imports or declarations. |
| Extracted helpers have direct or existing coverage | Pure models/share-link helpers, controller seams, presentation helpers, and shell owners are covered by the focused structure/behavior tests and the 392/392 complete app run. |
| Existing runner and distributed recipe tests pass | `distributed-recipes.test.ts` passed 36/36 and `control-run-manager.test.ts` passed 5/5 inside the exact 82/82 Iteration 1 command. |
| Structure gates reject legacy imports from Recipe Console and new App feature ownership | `app-structure.test.ts` passed 41/41 and retains its Recipe Console-to-legacy ban, App feature declaration/import ban, lazy-boundary checks, and exact owner DAG. |

#### Remaining risks and evidence ownership

| Remaining risk | Owning iteration(s) | Mitigation and evidence target |
| --- | --- | --- |
| Hidden mounted effects, polling, subscriptions, and runtime ownership | 1, 11 | Extract ownership before unmounting and satisfy `packages/tests/rallar-black-box/app-structure.test.ts` — `legacy routes resolve through dynamic imports only` plus `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts` — `default Recipe Console does not load or poll inactive legacy routes except registered stateful exceptions`. |
| Source, DOM, and CSS selector compatibility can regress during extraction | 1, 2, 11 | Preserve source/public boundaries and add the structure assertion plus `tests/playwright/rallar-black-box/recipe-console-shell.spec.ts` — `CSS isolation fixture preserves representative legacy and Recipe Console controls`. |
| URL/default flip and runner-agent launch compatibility | 2, 8, 12 | Iteration 8 now passes `tests/playwright/rallar-black-box/recipe-console-history.spec.ts` — `restores versioned view selection filters comparison and timing metric from a copied URL` and the preserved legacy runner-agent ticket pair. Iteration 12 still owns the blank-URL default flip and stale stored-legacy precedence proof. |
| Future artifact versions and new profile drift | 12 and future contract changes | Iteration 6 now proves profile/version-aware partial, malformed, future-schema, envelope, and generic-profile distinctions through the canonical Analyze acceptance and shared workspace tests. Preserve the additive compatibility inventory and rerun those gates whenever a producer changes. |
| Retention preview safety | 8 | Satisfied through `fd9055e`: optional dry-run behavior preserves the destructive default, guarded confirmation is explicit, and `tests/playwright/rallar-black-box/recipe-console-history.spec.ts` — `previews retention impact before confirmed destructive cleanup` passes. Preserve this gate for later changes. |
| Qualitative visual and performance gates lack executable thresholds | 12 | Iteration 2 has four approved screenshot baselines and a 1% executable drift budget in `recipe-console-concept-fidelity.spec.ts`; Iteration 9 now passes exact bounded-render/cardinality, accepted-to-paint heartbeat, complete responsive/input/reduced-motion, and same-machine advisory profiling gates. Iteration 12 still owns the final cross-product viewport, keyboard, touch, reduced-motion, and non-hover acceptance after the remaining surfaces and default flip land. |
| Preserved legacy Media and Rallar Data controls can be only 30px high (including the 932x430 landscape QA viewport) | 12 | Keep the parity extractions unchanged, then require at least 44px touch targets without overflow or hover-only affordances in the Iteration 12 accessibility gate. |
| Preserved legacy CRDT controls are 30px high at desktop and 932x430 landscape, and its fixed editor/diagnostic/table tracks create an 807px document at 430px portrait | 12 | Keep the exact parity extraction unchanged; add narrow-screen CRDT grid collapse and locally contained table scrolling, require 44px touch targets in touch viewports, and prove zero page overflow in `recipe-console-accessibility.spec.ts`. |
| Preserved legacy Auth, Groups/Clients, and Rallar Server action controls measure 42px across the desktop, portrait, and landscape QA viewports | 12 | Keep the exact parity extractions unchanged, then raise every actionable touch target to at least 44px in the Iteration 12 accessibility gate. |
| Legacy tab arrow keys update selection without transferring DOM focus to the selected tab | 12 | Preserve Iteration 1 parity, then make roving focus follow keyboard selection and encode the behavior in `recipe-console-accessibility.spec.ts`. |
| Local Node 26 differs from CI Node 24 | 1 and every code-changing iteration | Run the focused tests, typecheck, and build on CI Node 24; retain the local Node `26.5.0` result separately so version-specific differences remain visible. |
| The configured live/Postgres lifecycle remains unexecuted after the Iteration 5 code-backed exit | 8, 12, or the next available configured-service checkpoint | Run `npm run test:e2e:rallar-black-box:full-stack:real:distributed`, including `full-stack-recipe-console-monitor.spec.ts`; do not close Ready-State #3 from mock, discovery, no-environment skip, or sandbox-only evidence. |

### Iteration 0: Product Cut And Evidence Map

Goal: lock the lean scope before code movement.

Work:

- Inventory current runner surfaces in `App.tsx` and map each one to `Execute`, `Monitor`, `Analyze`, `Tune`, `Fleet`, or `Advanced`.
- Turn the initial strangler matrix above into a checked-in migration register with route alias, mount policy, owner, parity status, and rollback route for each surface.
- Mark top-level hiding/re-homing: direct Rallar tabs no longer appear in primary runner navigation, but they remain reachable through `Advanced Legacy` or contextual diagnostic links.
- Write acceptance stories for:
  - create and run ACK recipe
  - run RTC stream recipe
  - diagnose failed target resolution
  - import artifact and find first failure
  - compare two runs and tune stream cadence
- Define the first URL-state schema.

Exit criteria:

- A short product spec exists and every current runner feature is kept in the new primary flow, moved to advanced, or preserved as legacy.
- No surface is marked hidden until its cutover proof and rollback route are named.

Validation:

- No behavior change.
- Review against `apps/rallar-black-box/docs/current-state.md` and `apps/rallar-black-box/docs/distributed-recipe-execution-iterations.md`.

### Iteration 1: Extract Pure App Helpers

Goal: reduce rewrite risk by moving derivation out of React before changing UI, and establish that `App.tsx` will not receive new primary surfaces.

Work:

- Add an explicit code comment or module boundary note near the top-level route composition: new Recipe Console work belongs under `src/recipe-console/**`; old UI extraction belongs under `src/legacy/**`.
- Add `packages/tests/rallar-black-box/app-structure.test.ts` before moving panels so the module boundaries are executable constraints.
- Move app-local derivations still buried in `App.tsx` into focused modules:
  - history filters
  - diagnostic filters
  - artifact import status
  - timing format helpers
  - fleet filters
  - share-link builders
- Identify the first legacy extraction candidates that can move with minimal behavior risk:
  - `RunnerAdvancedPanel`
  - `RunManagerPanel`
  - `DistributedRecipesPanel`
  - `DistributedRunMonitorPanel`
  - `ImportedDistributedArtifactAnalysisPanel`
- Extract these as separate route/controller/view modules, not one aggregate legacy file.
- Keep imports stable through temporary barrels and compatibility adapters.
- Extract `LegacyAppShell.tsx` so `App.tsx` stops owning the complete tab tree before Recipe Console feature work begins.
- Add or expand Vitest coverage in `packages/tests/rallar-black-box`.

Exit criteria:

- `App.tsx` becomes visibly thinner without UI changes.
- `App.tsx` contains bootstrap/provider/experience routing only and declares no feature panel components.
- There is a documented rule that no new Recipe Console panel is added directly to `App.tsx`.
- The first extracted helper modules have tests or are covered by existing tests.
- Existing runner and distributed recipe tests still pass.
- The structure test fails if Recipe Console imports a legacy panel directly or if a new feature panel is declared in `App.tsx`.

Validation:

- `npx vitest run packages/tests/rallar-black-box/app-structure.test.ts packages/tests/rallar-black-box/distributed-recipes.test.ts packages/tests/rallar-black-box/control-run-manager.test.ts`
- `npm --workspace rallar-black-box run typecheck`

### Iteration 2: New Recipe Console Shell

Goal: add the lean shell beside the legacy UI with a distinct modern look and isolated styling.

Work:

- Produce and approve a compact concept set before implementation: desktop `Execute`, desktop failed `Monitor` with inspector open, mobile portrait `Monitor`, and mobile landscape timing/matrix. Treat the accepted concepts as the visual contract for density, hierarchy, typography, palette, component geometry, and interaction states.
- Record a color-role ledger for neutral context, primary accent, selected/focus, running, pass, fail, warning, stale, partial, and disabled. Pair every operational color with text/icon/shape so verdicts do not depend on color alone.
- Create `src/recipe-console/app/RecipeConsoleApp.tsx`.
- Create `RecipeConsoleShell` with top command bar, left navigation, main work surface, and inspector rail.
- Create `src/recipe-console/design/tokens.css` and `src/recipe-console/design/reset.css` under `.recipe-console`, then co-locate shell and component styles in CSS Modules.
- Add a small component set for the new visual system: icon button, command bar item, status pill, metric strip, selectable row, matrix cell, drawer, inspector, empty/stale/error state.
- Add `view` routing for `execute`, `monitor`, `analyze`, `tune`, `fleet`, and `advanced`.
- Bridge from existing `App.tsx` with the URL-backed migration switch `experience=recipe-console`, without removing existing tabs.
- Load `RecipeConsoleApp` and `LegacyAppShell` as separate experience chunks. A legacy surface opened from Recipe Console is a further lazy route.
- Add compact UI primitives with stable dimensions and explicit control typography.
- Add a visual comparison checklist for the new shell: desktop, mobile portrait, mobile landscape, reduced motion, keyboard focus, stale state.
- Add a side-by-side CSS isolation fixture containing representative new and legacy controls, tables, status pills, forms, and dialogs.

Exit criteria:

- The new shell renders with seeded/sample state and no backend dependency.
- Legacy runner surfaces remain reachable.
- The new shell is visually distinct from the old panels without CSS leakage into legacy UI.
- No new shell styling depends on broad `.panel`, `.metric`, `.workspace-grid`, or legacy tab selectors.
- Browser screenshots match the approved concepts closely enough that hierarchy, density, palette, typography, and selected/error states have no unexplained drift.
- The Recipe Console default chunk does not contain every legacy diagnostic surface.

Validation:

- `npm --workspace rallar-black-box run typecheck`
- Playwright smoke: load the new shell, switch views, verify no overflow at desktop and mobile widths.
- Playwright visual/interaction smoke for the CSS isolation fixture, keyboard focus, drawer behavior, and reduced motion.

### Iteration 3: Control Connection And Agent Board

Goal: make live/stale/offline control-server state the backbone.

Work:

- Wrap existing control APIs into `recipe-console/control/control-api.ts`.
- Add polling with last-updated, live/stale/offline/partial states.
- Render top command bar with control server, selected control run, group, connected agents, targetable agents, and active distributed run.
- Render agent board from `deriveControlAgentBoardRows(...)` and `summarizeControlAgentBoardRows(...)`.
- Add URL state for selected control run and agent.

Exit criteria:

- A user can tell whether the control server is reachable and which agents are safe to target before selecting a recipe.

Validation:

- `npx vitest run packages/tests/rallar-black-box/control-client.test.ts packages/tests/rallar-black-box/control-run-manager.test.ts`
- `cd apps/rallar-black-box-control-server && deno task test`
- UI Playwright test for stale/offline/connected states using mocked or seeded snapshots.

### Iteration 4: Execute Workflow MVP

Goal: replace raw distributed-run operation with a guided execution path.

Work:

- Add recipe catalog with profile search, live-service badges, schema-valid badges, and preflight summary.
- Add target resolution panel with matched, stale, offline, duplicate, missing identity, wrong group, and missing capability states.
- Add manifest builder using existing `buildDistributedRunManifest(...)` and shared manifest validation.
- Add `Create`, `Stage`, `Start`, `Cancel`, `Refresh`, `Export` actions.
- Keep raw manifest JSON in a disclosure panel.
- Dangerous live actions require clear state, not a decorative warning.

Exit criteria:

- A user can select a recipe, resolve targets, stage, and start without editing JSON.

Validation:

- `npx vitest run packages/tests/rallar-black-box/distributed-recipes.test.ts packages/tests/rallar-black-box/schema-authoring.test.ts`
- `npm --workspace rallar-black-box run typecheck`
- Playwright: execute simulated distributed ACK through visible controls.

### Iteration 5: Monitor MVP

Goal: make active run status readable in under five seconds.

Work:

- Use `deriveDistributedRunMonitor(...)`.
- Render verdict, failures, agent progress matrix, recipe progress, ACK readiness, barrier readiness, runtime diagnostic counts, and artifact validation.
- Add timeline and event list as secondary evidence, not the first thing on screen.
- Add selected inspector for agent, recipe, command, diagnostic, and failure rows.
- Preserve last-known-good evidence during refresh failures.

Exit criteria:

- For a running or failed distributed run, the first visible region answers: what happened, who is affected, and what to inspect next.

Validation:

- `npx vitest run packages/tests/rallar-black-box/distributed-recipes.test.ts`
- Playwright: controlled one-agent failure rolls up visibly and links to diagnostic/event evidence.

### Iteration 6: Artifact Analysis

Goal: make CI/offline artifacts as useful as live runs.

Work:

- Add file import for distributed artifact bundles.
- Add control-server artifact load/export.
- Use `analyzeDistributedRunArtifactFiles(...)` and `distributedArtifactSnapshotsFromFiles(...)`.
- Render failure analysis, causal trail, evidence quality, missing-file warnings, and issue-ready markdown.
- Add artifact search over events/results/failures by agent, command, topic, diagnostic type, payload summary, and time window.

Exit criteria:

- A user can drop a CI artifact bundle into the SPA and identify the first actionable failure without opening raw JSON.

Validation:

- `npx vitest run packages/tests/rallar-black-box/distributed-recipes.test.ts packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts`
- Playwright: import fixture artifact and verify failure focus plus performance summary.

### Iteration 7: Timing And Recipe Tuning Lab

Goal: turn performance artifacts into recipe tuning decisions.

Work:

- Render command timing percentile strips and slowest-agent rows.
- Render stream frame disposition, achieved Hz, drift, late frames, backpressure, and slowest stream agent rows.
- Add baseline comparison against previous run or selected run.
- Add rule-based tuning hints sourced from shared-test analysis categories.
- Add a recipe knob inspector for `rateHz`, `durationMs`, `intervalMs`, `maxInFlight`, `ackTimeoutMs`, `barrier.timeoutMs`, and stream thresholds.
- Support copyable "candidate recipe changes" as JSON patch or manifest diff, but do not auto-mutate recipes silently.

Exit criteria:

- A user can answer whether a recipe should lower rate, raise timeout, adjust stream thresholds, fix target readiness, or investigate a specific agent.

Validation:

- Vitest for timing derivation and tuning hint rules.
- Playwright: loaded stream artifact shows frame disposition, p95/p99, drift, drops, and a tuning hint.

### Iteration 8: History, Compare, Saved Filters, Retention

Goal: make repeated distributed work organized.

Work:

- Add history table with URL-backed filters: group, recipe, profile, status, failure category, date range, text.
- Add saved filter presets stored locally first; leave room for remote saved views later.
- Add compare view using `compareDistributedRuns(...)`.
- Add retention preview and cleanup controls against `POST /retention/cleanup`. Preview must use a backward-compatible non-destructive dry run such as optional `dryRun: true`; preserve the existing destructive default and require explicit confirmation before cleanup.
- Add copy/share link for current filtered or compared view.

Exit criteria:

- A user can find a past failure, compare it to a candidate fix, and clean old local runs with previewed impact.

Validation:

- `cd apps/rallar-black-box-control-server && deno task test`
- `npx vitest run packages/tests/rallar-black-box/distributed-recipes.test.ts`
- Playwright: filter history, compare two seeded runs, run retention preview/cleanup path.

### Iteration 9: Large-Run Scale And Virtualization

Goal: keep the SPA responsive for large distributed artifacts.

Work:

- Add cursor/windowed event and result browsing.
- Virtualize large tables and artifact search results.
- Respect artifact index compaction summaries.
- Move dense timing plots to Canvas only when SVG/DOM profiling shows real pressure.
- Add bounded snapshot controls by default.
- Add performance telemetry for render counts, rows, and artifact parse duration.

Exit criteria:

- Large artifacts remain searchable and readable without freezing the browser.

Validation:

- Synthetic large artifact fixture.
- Browser performance smoke with event/result counts above current defaults.
- `npm --workspace rallar-black-box run typecheck`

### Iteration 10: Fleet And Geographic Evidence

Goal: keep fleet analysis useful without turning the SPA into a map app.

Work:

- Treat the existing behavior-preserving `src/legacy/runner/fleet/**` controller/view extraction as the legacy route owner; preserve its exact active-only mount and parity locks.
- Build the new `recipe-console/fleet` view from shared deterministic helpers; do not import the legacy panel.
- Keep live board, heatmap, region summaries, repeated failure signatures, timing distributions, and deterministic SVG map.
- Add links from failure signatures to filtered history and affected agents.
- Add route evidence only when source/target locations are explicit or documented.

Exit criteria:

- Fleet answers: which agents/regions repeatedly fail, whether it is timing-related, and which run/artifact proves it.

Validation:

- Existing fleet report tests.
- Playwright: fleet filters and map layer URL state restore.

### Iteration 11: Advanced Diagnostics Bridge

Goal: preserve powerful direct tools without letting them clutter the core flow.

Work:

- Move legacy direct Rallar tabs under `Advanced Legacy` or behind contextual links.
- Add deep links from failures to relevant diagnostics:
  - auth/ticket failures to Auth and WebSocket
  - no peer/no route to RTC Diagnostics
  - missing group/member to Groups/Clients
  - server status failures to Rallar Server
- Lazy-load and mount legacy UI only when opened unless its migration-register entry documents a stateful exception.
- Move background polling or execution ownership out of panel visibility before unmounting a surface that currently depends on staying mounted.
- Preserve existing query aliases and old tab links. A link that used to open `tab=distributed-recipes` should still open the legacy distributed recipe surface or redirect to the matching Recipe Console view with a visible legacy fallback.

Exit criteria:

- The core SPA is lean, but no important diagnostic path disappears.
- Legacy surfaces are hidden from the primary path but still findable and testable.
- Opening Recipe Console without `Advanced Legacy` leaves legacy route chunks unloaded and legacy polling effects inactive.

Validation:

- `npx vitest run packages/tests/rallar-black-box/app-tabs.test.ts packages/tests/rallar-black-box/rallar-mode-boundary.test.ts packages/tests/rallar-black-box/app-structure.test.ts`
- Playwright: advanced links open with context and return to selected run.

### Iteration 12: Polish, Accessibility, And Default Flip

Goal: make the new SPA the default.

Work:

- Desktop, mobile portrait, and mobile landscape QA.
- Keyboard paths for navigation, tables, disclosures, filters, and dialogs.
- Reduced-motion handling for live updates.
- Contrast and semantic color audit for pass/fail/warn/stale/selected states.
- Empty, partial, stale, offline, loading, permission, schema-error, and artifact-missing states.
- Replace default runner workspace with Recipe Console.
- Flip workflows individually using their migration-register status. Green `Execute`, `Monitor`, `Analyze`, and `Tune` core gates are necessary but not sufficient; the final default changes only after all 14 Ready-State items have evidence.
- Keep old runner UI under `Advanced Legacy`. Any future retirement requires a separate explicit plan after parity and usage review.

Exit criteria:

- Opening `apps/rallar-black-box` gives a tidy SPA ready to execute and analyze distributed recipes.
- `App.tsx` meets the ownership rule and target size; no replacement shell or legacy registry has become a new monolith.

Validation:

- `npm --workspace rallar-black-box run typecheck`
- `npm run build:rallar-black-box`
- `npx vitest run packages/tests/rallar-black-box/distributed-recipes.test.ts packages/tests/rallar-black-box/control-run-manager.test.ts packages/tests/rallar-black-box/schema-authoring.test.ts`
- `cd apps/rallar-black-box-control-server && deno task check`
- `cd apps/rallar-black-box-control-server && deno task test`
- `npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/tabbed-navigation.spec.ts`
- `npm run test:e2e:rallar-black-box:full-stack:real:distributed` when live services are available

## Ready-State Definition

The SPA is ready when these are true:

- The default first screen is distributed recipe execution, not a general command center.
- A simulated distributed ACK run can be completed from visible controls.
- A live distributed run can be staged, started, monitored, cancelled, and exported when services are configured.
- Failures are listed before raw event streams.
- Every failure row links to agent, command, recipe, diagnostic, timeline, and artifact evidence when available.
- Artifact import works without a control server connection.
- Timing analysis surfaces command percentiles and RTC stream-specific health.
- Compare mode shows changed recipes, participants, failures, timings, and received-message deltas.
- URL state restores selected view, run, filters, comparison, and timing metric.
- Large event/result lists are bounded or virtualized.
- Direct Rallar tools exist as advanced diagnostics, not primary navigation.
- Existing legacy UI elements remain reachable through advanced/contextual routes, even when hidden from the main flow.
- Hidden legacy routes are not mounted or loaded on the default path unless a documented state-preservation exception requires it.
- Desktop and mobile views are usable without hidden hover-only evidence.

## Risks And Guardrails

- Do not reimplement runner logic in React. Recipes, rollups, target resolution, schemas, artifacts, and timing derivation belong in `packages/shared-test`.
- Do not turn the SPA into a shell executor. Browser agents should be orchestrated through the control server.
- Do not make raw JSON the success path. JSON is an escape hatch and artifact format.
- Do not hide stale/offline/partial states. Operational users need last-known-good evidence.
- Do not loosen recipe thresholds before target readiness and transport diagnostics are clean.
- Do not use maps or 3D unless location or depth is real evidence.
- Do not remove existing UI elements as part of the strangler rewrite unless a separate explicit retirement task says so.
- Do not use `hidden` or `display: none` as the default long-term migration mechanism. Hide from primary navigation, retain a route, and unmount/lazy-load the implementation.
- Do not let `App.tsx` continue to grow. New surfaces go under `src/recipe-console/**`; old surfaces move toward `src/legacy/**`.
- Do not create a second monolith in `RecipeConsoleApp.tsx`, `LegacyAppShell.tsx`, a surface registry, or one global Recipe Console stylesheet.
- Preserve public exports and existing control-server endpoints unless a later task explicitly introduces a breaking migration.
