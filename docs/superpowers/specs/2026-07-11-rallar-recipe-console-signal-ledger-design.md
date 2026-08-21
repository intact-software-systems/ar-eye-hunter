# Rallar Recipe Console Signal Ledger Design

Status: approved visual and interaction contract
Approval: user approved Direction A, **Signal Ledger**, on 2026-07-11
Scope: Iteration 2 of the Rallar Black Box SPA reimplementation

## Purpose

Recipe Console is the operator product for executing, monitoring, analysing,
comparing, and tuning distributed recipes. It makes recipe execution and
failure evidence the primary experience while keeping every legacy route and
direct Rallar diagnostic available through the strangler boundary.

Iteration 2 establishes the new experience shell, visual system, URL-backed
view selection, responsive behavior, isolated styling, and seeded operational
states. It does not claim live workflow cutover. Execute, Monitor, Analyze,
Tune, Fleet, and Advanced become routable product destinations; later
iterations replace seeded surfaces with live features one workflow at a time.

## Approved concepts

The checked-in concepts are the visual source of truth for composition and
interaction hierarchy:

| State                                 | Concept                                                                                                   | Native generated size |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------- |
| Desktop Execute                       | `apps/rallar-black-box/docs/recipe-console-concepts/iteration-2-signal-ledger-execute-desktop.png`        | 1586 × 992            |
| Desktop failed Monitor with inspector | `apps/rallar-black-box/docs/recipe-console-concepts/iteration-2-signal-ledger-monitor-failed-desktop.png` | 1586 × 992            |
| Mobile portrait Monitor               | `apps/rallar-black-box/docs/recipe-console-concepts/iteration-2-signal-ledger-monitor-portrait.png`       | 851 × 1847            |
| Mobile landscape Tune timing/matrix   | `apps/rallar-black-box/docs/recipe-console-concepts/iteration-2-signal-ledger-tune-landscape.png`         | 1847 × 851            |

The implementation must reproduce the concepts' hierarchy, density, palette,
typography, geometry, selection/error states, and responsive transformations.
Generated screenshots are references only; all application text, controls,
tables, charts, icons, and state remain code-native and accessible. Repository
fixtures and deterministic derivations are authoritative for recipe names,
run identities, target counts, messages, timings, and evidence. When concept
copy conflicts with repository truth, the implementation uses the repository
value and records the intentional copy deviation in the fidelity ledger.

## Direction decision

Signal Ledger uses a cool light canvas, cobalt action color, flat ruled
regions, compact evidence tables, a persistent command band, labeled primary
navigation, and one contextual inspector. Hierarchy comes from type, rules,
selection rails, status shapes, and spatial continuity rather than nested
cards or decoration.

Two alternatives were rejected:

- **Night Scope** had strong live-operations presence but introduced an
  unrequested dark-theme contract, more contrast work, and poorer long-form
  artifact readability.
- **Field Draft** was calm and distinctive but its warm paper palette competed
  with warning states and weakened the urgency of live execution failures.

## Product information architecture

Primary destinations appear in this exact order:

1. Execute
2. Monitor
3. Analyze
4. Tune
5. Fleet
6. Advanced

Failures and actionable evidence appear before event streams or raw JSON.
Direct Auth, Groups, WebSocket, RTC, Data, CRDT, Media, Server, and tracing
tools never enter primary navigation. During migration they remain available
through the lazy legacy experience and, later, contextual Advanced routes.

## Experience and URL behavior

New links use the product-spec `v=1` codec. During Iteration 2:

- `experience=recipe-console` explicitly opens Recipe Console and is
  canonicalized to `v=1`; every link emitted by Recipe Console includes
  `v=1`.
- `experience=legacy` explicitly opens the legacy shell.
- A blank URL and old `workspace`, `appMode`, `tab`, `advancedSurface`, or
  `advanced` links continue to open the exact legacy experience until the
  Iteration 12 default flip.
- A valid explicit `v=1` Recipe Console URL wins over stored personal defaults
  and old aliases.
- Recipe Console defaults to `view=execute` when its view is absent or invalid;
  the fallback is visible and all other valid fields are retained.
- Committed view, selection, filter, comparison, and legacy-route changes push
  history. High-frequency range or viewport changes replace history.
- Popstate restores the complete validated state without remounting both
  experiences.

The typed codec covers the full approved field set even where a later
iteration first consumes a field: `v`, `experience`, `view`, `controlRunId`,
`distributedRunId`, `agentId`, `recipeId`, `commandId`,
`diagnosticSeverity`, `transport`, `historyQuery`, `status`, `from`, `to`,
`compareLeft`, `compareRight`, `timingMetric`, `fleetRegion`,
`fleetMapLayers`, and `legacySurface`.

Secrets, credentials, tickets, artifact payloads, hover state, pointer state,
and animation state never enter the URL or local storage.

## Experience boundary

`App.tsx` remains provider/bootstrap/auth/experience-routing glue. Recipe
Console and the legacy shell are separate lazy experience chunks. Legacy-only
navigation, runner selection, global-context synchronization, polling, and
panel effects mount only inside the legacy experience. Explicit Recipe Console
navigation must not load every direct diagnostic surface.

The boundary is one-way:

```text
App
├── lazy RecipeConsoleApp
└── lazy LegacyExperience
    └── LegacyAppShell
```

Recipe Console feature modules do not import legacy React panels. The only
permitted future exception is a dedicated compatibility router contract whose
implementations are dynamically imported. In Iteration 2, Advanced links back
to the explicit legacy experience without statically importing it.

## Shell anatomy

### Desktop, 1200px and wider

- Command bar: 52px high.
- Primary navigation: 184px labeled rail.
- Main work surface: `minmax(0, 1fr)`.
- Inspector: 352px normally and 360px for a failed Monitor selection.
- The shell fills `100dvh`; body/document scrolling is disabled inside the
  experience. Work and inspector regions scroll independently.
- The grid is edge-to-edge. There is no centered dashboard wrapper.

### Compact/tablet, 768–1199px

- Navigation contracts to a 64px rail.
- Main work surface owns remaining width.
- Inspector overlays from the right at 360px and never squeezes a matrix.

### Portrait, 767px and narrower

- Command bar: 52px.
- Optional context strip: 44px.
- Work surface: one vertical scroller with 16px gutters.
- Selection dock: 48px when an evidence item is selected.
- Bottom navigation: 64px, six destinations, visible labels, and at least
  44×44px targets.
- Inspector and filters share one modal-sheet host. Only one inspector subtree
  exists; no CSS-hidden duplicate is retained.
- The matrix is the only horizontally scrollable region.

### Short landscape, at least 720px wide and at most 520px high

- Command bar: 48px.
- Navigation: 60px compact labeled icon rail, never bottom navigation.
- Matrix/timing canvas: 52/48 split with a 12px ruled divider.
- No document scroll. Each pane owns contained vertical scrolling; the matrix
  owns contained horizontal scrolling.
- Inspector overlays from the right at 320px and does not resize the matrix.

Every grid child uses `min-width: 0` and `min-height: 0`. Long IDs ellipsize
with a visible copy action. Critical evidence is never hover-only.

## Screen contracts

### Desktop Execute

The top bar exposes Recipe Console, control status, selected run/context,
targetability, refresh, and copy-link actions. Execute is selected in the
primary rail.

The work surface contains three continuous regions:

1. A searchable recipe ledger backed by
   `RALLAR_BLACK_BOX_RECIPE_FIXTURES`, with `RTC Realtime Stability` selected
   and visible repository entries including `Provider Parity`,
   `Composite Evidence`, and `Expected Failure`. The selected shared fixture is
   configured through `createRallarBlackBoxRtcRealtimeStabilityRecipe(...)`
   with the explicit sample group `rallar-server/default/seed-room`, matching
   the sample target snapshot exactly; the adapter does not rewrite agents.
2. A deterministic sample target table followed by an expanded Preflight tree.
   It uses the two targetable rows derived from the existing `passed-clean`
   control snapshot (`seed-agent-a` / alice and `seed-agent-b` / bob), defaults
   to 2/2 selected, and is explicitly labelled as sample data. Schema and
   target resolution may read ready; live Control connectivity reads
   `Required · not checked in preview` rather than implying a backend result.
3. A `Recipe details` inspector with provider, group, target count, schema,
   description, and the selected fixture's real five-command sequence. Its
   summary reads `5 manifest commands - 25 stream frames`; the interaction
   stages are Stage/load → ACK/readiness → Start/run → Result. A Barrier stage
   appears only when a real manifest declares a barrier policy.

A stable action band shows the derived ready/target count, Export, disabled
Cancel with a visible reason, Stage, and one primary Start action. Iteration 2
actions update local seeded state only and are visibly identified as preview
behavior; live execution is Iteration 4 work.

### Desktop failed Monitor

Evidence order is fixed:

1. Failed verdict band.
2. `Failures (2)` selectable ledger.
3. `Agent × phase` matrix.
4. `Timeline & raw evidence` as secondary evidence.

The seeded run is the existing `failed-command` fixture, derived through the
production monitor/report/verdict helpers. It has distributed run
`seed-failed-command`, control run `seed-control-failed-command`, recipe
`seed-rtc-recipe`, and two agents with one failed. Its two failure-ledger rows
are the recipe rollup (`SYNTHETIC_RECIPE_FAILED`) and command result
(`SYNTHETIC_ASSERTION_FAILED`), both reading `Receiver did not observe the RTC
payload.` The selected command failure is associated with `seed-agent-b` and
`seed-start-receiver`; only that command row is directly correlated with the
runtime diagnostic.

The open inspector contains `Likely cause`, `Next action`, `Minimal fix area`,
and `Correlated evidence`. Likely cause, next action, and evidence links come
from the derived verdict and causal trail. Minimal fix area is a deterministic
presentation mapping of the selected failure's agent, command, and recipe IDs.
`Open legacy RTC diagnostic` is explicitly labelled compatibility navigation,
not derived evidence.

Stale/reconnecting variants preserve last-known failures and matrix data under
a visible `Stale · reconnecting` line; a spinner never replaces known evidence.

### Portrait Monitor

Content order is verdict, actions, failures, contained matrix, collapsed
timeline, selection dock, and bottom navigation. The failure inspector is
closed in the approved frame and opens from `Failure · seed-agent-b` / `Inspect`
as a modal bottom sheet. The matrix uses a sticky 116px agent column, 56px
phase columns, 44×44px cells, and a persistent `Swipe phases` affordance.

### Landscape Tune

The command bar reads `Tune · RTC timing` and includes control status,
candidate `seed-high-latency-rtc`, `Passed`, Compare, and More. A baseline is
shown only when one is present in validated URL state; Iteration 2 never
invents a comparison run.

The left pane is the Agent × phase matrix. The right pane is Timing with a
segmented selector for Command, Send duration, Drift, and Cadence. Its default
data is the existing `high-latency-rtc` fixture derived through
`deriveRtcPerformanceView(...)`: three per-agent mean stage/start samples at
112.5 ms, 1,010 ms, and 1,190 ms, with P50 1,010 ms and P95/P99/Max 1,190 ms.
The stage/start source
durations remain 95/130 ms, 980/1,040 ms, and 1,120/1,260 ms. Metrics that the
fixture does not contain, including frame disposition, cadence, drift, and
backpressure, render as unavailable rather than invented. The surface labels
this state `Command-duration only · RTC timeline unavailable`. The distribution
plot is a real SVG/data visualization surface, not a decorative bitmap.

## Visual tokens

Tokens live under `.recipe-console` in
`src/recipe-console/design/tokens.css`. The narrow reset lives in
`src/recipe-console/design/reset.css`. Neither file defines broad legacy
selectors such as `.panel`, `.metric`, `.workspace-grid`, or legacy tabs.

| Role          | Background / foreground / border    | Non-color contract                                      |
| ------------- | ----------------------------------- | ------------------------------------------------------- |
| Canvas        | `#F5F7FA` / `#172033` / `#D5DBE3`   | Spatial hierarchy and persistent region headings        |
| Surface       | `#FFFFFF` / `#172033` / `#D5DBE3`   | Rules and headings, not shadow-only separation          |
| Rail          | `#EEF1F5` / `#172033` / `#D5DBE3`   | Visible navigation labels and icons                     |
| Primary       | `#2446C2` / `#FFFFFF` / `#2446C2`   | One dominant labeled action per command region          |
| Primary hover | `#1937A2` / `#FFFFFF` / `#1937A2`   | Same label/icon, no movement                            |
| Selected      | `#E7ECFF` / `#1B3696` / `#3659D4`   | 3px selection rail/check plus `aria-selected`           |
| Focus         | transparent / inherited / `#315CF3` | 2px focus ring with offset                              |
| Running       | `#E4F5F7` / `#065D6B` / `#16808F`   | Notched-ring icon, `Running`, elapsed time              |
| Passed        | `#E7F5ED` / `#14633F` / `#2E815C`   | Check-circle and `Passed`                               |
| Failed        | `#FCEBED` / `#981F2C` / `#C3424F`   | X-octagon, `Failed`, solid leading rule                 |
| Warning       | `#FFF2D5` / `#774600` / `#A86600`   | Warning triangle, label, remediation text               |
| Stale         | `#EEF1F4` / `#4E596A` / `#707B8C`   | Clock, `Stale`, age text                                |
| Partial       | `#F1EBFF` / `#59379A` / `#7A55B8`   | Half-filled circle, `Partial`, available/expected count |
| Disabled      | `#EEF1F4` / `#616B79` / `#D4D9E1`   | Preserved label and accessible reason; not opacity-only |

Normal text/background pairs target WCAG AA 4.5:1. Status boundaries and focus
indicators target at least 3:1 against adjacent fills.

## Typography and geometry

- UI font: Inter when available, then `ui-sans-serif`, system UI, and standard
  platform fallbacks.
- Default UI text: 13px.
- Metadata: 12px.
- Evidence text: 14px.
- Section heading: 18px.
- Verdict: 22–24px.
- IDs, timestamps, durations, percentiles, and counts use `ui-monospace` with
  tabular numerals.
- Sentence case is standard. Uppercase is reserved for short machine-state
  identifiers such as `RECIPE_FAILED`.
- Desktop interactive rows and controls are 36–44px. Touch controls are at
  least 44×44px with 8px separation.
- Controls have at most 6px radius. Overlays have at most 8px radius. Data
  regions may be square.
- Shadows appear only on modal sheets, drawers, and dialogs.

## Icon contract

Use one 16/18px outline icon family with approximately 1.75px stroke. Keep
metaphor, stroke, optical size, color, and alignment consistent. Navigation and
uncommon commands retain visible text. Icon-only buttons require an accessible
name and tooltip. Statuses use distinct shapes and labels. Emoji and text baked
into SVG are prohibited.

## Component system

The shell and primitives remain focused:

```text
RecipeConsoleApp
└── RecipeConsoleShell
    ├── TopCommandBar
    ├── PrimaryNavigation
    ├── WorkSurface
    └── InspectorHost
```

`PrimaryNavigation` renders sidebar, compact rail, or portrait bottom-nav
variants from one item model. `InspectorHost` moves one inspector subtree among
rail, overlay, and sheet presentations. It never renders hidden duplicates.

Required reusable primitives are IconButton, CommandBarItem, StatusMark,
SelectableRow, MatrixCell, SegmentedControl, Drawer/Sheet, Inspector,
EmptyState, StaleState, and ErrorState. Tables, lists, rails, matrices, and
continuous work planes are preferred over cards.

Feature preview owners for Iteration 2 are separate Execute, Monitor, Analyze,
Tune, Fleet, and Advanced view modules. `RecipeConsoleApp` composes them and
stays below 400 lines; route files stay below 700 lines; presentational files
stay below 300 lines; CSS Modules stay below 400 lines.

## Seeded states and operational behavior

Iteration 2 must render without backend services. Seeded state is deterministic
and product-shaped, not random. Execute uses the shared recipe fixtures plus an
explicit sample target adapter; Monitor uses `failed-command`; Tune uses
`high-latency-rtc`; both run views consume the same production derivations as
the current application. The shell supports selected rows/cells, view changes,
inspector open/close, metric selection, bottom-sheet behavior, stale/error/
empty examples, and copied URL state.

Later iterations replace seeded adapters with control queries and shared-test
derivations without changing the shell or design primitives.

## Motion and focus

- Selection/control feedback: 100–160ms.
- Drawer/sheet transition: at most 220ms.
- Live-row emphasis may fade once for at most 600ms.
- There is no perpetual glow, shimmer, or layout-shifting animation.
- Reduced motion removes transform travel, pulses, chart interpolation, and
  repeated emphasis. State remains visible immediately.
- Focus order is command bar, primary navigation, route header/actions, work
  sections in visual order, then inspector.
- Opening an overlay/sheet traps focus; Escape closes it and restores focus to
  the selected row/cell.
- Navigation uses roving focus with arrows/Home/End and Enter/Space activation.
- Matrix arrows move cell focus; Enter/Space opens inspection.

## CSS isolation fixture

The checked-in fixture is a separate Vite-served HTML entry used only for
visual and automated QA. It renders representative new and legacy controls,
tables, status marks, forms, and dialog geometry side by side. It imports the
legacy stylesheet and Recipe Console scoped styles but no legacy React panel.

The fixture proves:

- Recipe Console selectors have no effect outside `.recipe-console`.
- Recipe Console does not depend on broad legacy selectors.
- Legacy `.panel`, `.metric`, form, table, pill, and dialog styles remain
  unchanged next to the new system.
- The default Recipe Console bundle does not include the fixture entry.

## Verification and fidelity

Iteration 2 is not complete until:

- Typecheck and production build pass.
- Unit/structure tests prove the URL codec, experience precedence, App boundary,
  dynamic imports, module caps, and CSS selector isolation.
- Browser smoke proves all six views, history/popstate, legacy fallback, and
  seeded operation without backend services.
- Desktop, 430×932 portrait, and 932×430 landscape have no document overflow.
- Keyboard, focus restoration, touch targets, reduced motion, empty/stale/error
  states, and the isolation fixture pass.
- Resource inspection proves explicit Recipe Console does not request the
  legacy experience or diagnostic modules.
- Fresh 1440×900 desktop, 430×932 portrait, and 932×430 landscape screenshots
  are compared side by side with all four native-size approved concept images
  using `view_image` in the final QA pass.
- A fidelity ledger covers copy, layout, typography, palette/statuses, icons,
  geometry, responsive transformation, motion, and any intentional deviation.

## Deferred work and non-goals

- No workflow is marked cut over in Iteration 2.
- No legacy primary-navigation item is hidden or removed.
- No live control query/polling contract is introduced before Iteration 3.
- No recipe execution is claimed before Iteration 4.
- No Monitor, Analyze, Tune, Fleet, or Advanced replacement is claimed before
  its documented iteration and acceptance proof.
- No default flip occurs before Iteration 12.
- No public export, control-server endpoint, artifact contract, or app import
  path is broken.
