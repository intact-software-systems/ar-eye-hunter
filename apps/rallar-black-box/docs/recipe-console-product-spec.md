# Recipe Console Product Spec

Status: canonical product contract; Ready-State #1–#14 are code-backed and
executed through Iteration 12, `4f04228`, and `aec6e57`; Recipe Console is the
blank/provider-only URL default. Browser-agent launch and the execution runway
are code-backed and current-UI configured-live qualified. Their moderated-human
gate and the wider aggregate live-RTC qualification remain open. The preserved
legacy experience remains an operational rollback.
Evidence date: 2026-07-15

This document is the source of truth for Recipe Console scope, acceptance stories, URL state, artifact compatibility, and Ready-State evidence. Surface migration is tracked in the [Recipe Console migration register](./recipe-console-migration-register.md); execution status, binding decisions, validation evidence, and risks are tracked in the [SPA reimplementation plan](../../../playground/rallar-black-box-spa-reimplementation-plan.md).

## Product cut

Recipe Console is the operator product for executing, monitoring, analysing, comparing, and tuning distributed recipes. Direct Rallar tools remain available as advanced diagnostics and contextual escape hatches; they are not the primary product.

The primary information architecture is:

1. `Execute`
2. `Monitor`
3. `Analyze`
4. `Tune`
5. `Fleet`
6. `Advanced`

The default product path starts with recipe execution and promotes failures and actionable evidence ahead of raw JSON or event noise.

## Non-goals

- No shell executor in the browser. External runner execution remains explicit tooling or control-server work.
- No browser-process, Playwright-worker, remote-headless, VM, or infrastructure provisioning. Execute launches local control-agent pages or copies links for manual opening.
- No control protocol, artifact contract, shared-test public export, control-server endpoint, or app import-path break.
- No deletion or retirement of legacy surfaces in this strangler project.
- No generic admin-console redesign of direct Auth, Groups, WS, RTC, Data, CRDT, Media, Server, or tracing tools.
- No automatic mutation of recipes. Tuning may produce explicit copyable candidate changes, but applying them is a separate deliberate action.

## Observable acceptance stories

### Simulated ACK execution

**Given** Recipe Console is using the simulated provider with no connected agents and a schema-valid ACK recipe is visible in the catalog, **when** an operator selects Composite Evidence, opens three local browser agents, resolves the exact launched cohort, creates the draft, stages it, confirms Start, and opens Monitor through visible controls, **then** the UI shows the resulting run identity, progress, and terminal verdict without JSON editing, a manual Refresh, DOM-injected clicks, or legacy navigation.

### Browser-agent launch and popup fallback

**Given** Execute has no current-safe targets, **when** an operator enters an
exact control-run ID, agent prefix, and count from one through six, **then** the
inline setup can synchronously reserve local tabs and navigate them after fresh
per-agent authority is minted. If popups are blocked, no authority is minted
for wholly blocked tabs and whole-cohort or per-agent Copy actions remain
available. Each launched agent uses `mode=control`, the selected group and
origins, a unique agent ID, and the exact entered run ID.

`browser-rallar` launch is available only after the global login gate restores
or creates a valid operator session. It always mints fresh per-agent API
sessions. Simulated agents use `actor=agentId` and
`sessionId=${agentId}-session` so one browser session cannot collapse the
cohort into duplicate identities.

### Human execution runway

Execute derives one forward action from authoritative control, resolution, and
distributed-run state. Resolve, Create, and Stage are direct actions. Start and
Cancel use accessible confirmation dialogs. Registration and ACK waiting
advance through the root query poller; Refresh remains a secondary recovery
control, never a required happy-path step. Future phases are labels, not
disabled buttons, and the running/terminal successor is `Monitor run` with both
run identities retained.

### RTC stream evidence

**Given** configured RTC-capable agents and an RTC stream recipe, **when** an operator stages and runs the recipe, **then** Monitor and Tune show planned/completed/failed/dropped frames, achieved cadence, drift, late frames, send-duration percentiles, and backpressure/in-flight-drop evidence linked to affected agents.

### Target-resolution failure before staging

**Given** a recipe whose required targets include missing, stale, offline, duplicate, wrong-group, or capability-incompatible agents, **when** the operator resolves targets, **then** Execute explains each non-targetable agent and blocks staging until the readiness problem is corrected or the target selection is changed.

### Offline artifact analysis

**Given** no control-server connection and a partial or complete supported artifact bundle, **when** the operator imports the files locally, **then** Analyze retains all usable evidence, warns visibly about missing or incompatible files, and focuses the first actionable failure with likely cause, next action, and evidence source. When a correlated failed result contains structured error evidence, its code, runtime name, actionable message, and retained stack are operator-readable from the verdict, result row, and inspector without making raw JSON the primary path.

The same workspace accepts the existing control-server export envelope, keeps
artifact bytes only in bounded memory, searches normalized failure/result/event/
diagnostic evidence through v1 URL filters, exports without a second request,
and visibly rejects generic black-box-runner artifacts to the preserved Shared
Test importer. Unknown schema versions and malformed optional evidence remain
inspectable and can never be presented as a supported bundle; the artifact's
claimed run outcome remains visible beside the incompatibility warning.
The existing result payload summary remains available through a collapsed raw-
payload disclosure for source verification.

### Run comparison and candidate tuning

**Given** two compatible run snapshots or artifact bundles, **when** the operator selects them as comparison inputs, **then** Tune shows recipe, participant, failure, timing, and received-message deltas and produces explicit candidate timing changes without silently mutating either recipe.

### Server history and saved filters

**Given** server run history, **when** the operator opens Tune, **then** current
timing and candidate evidence remains first and a bounded History ledger follows
with explicit root/fallback/stale/partial provenance, URL-backed semantic
filters, saved local filter presets, safe Baseline/Candidate handoff, exact
filtered/rendered/omitted counts, and no artifact-derived synthetic server row.
At most 80 History rows mount in one active Iteration 9 window and every match
remains browseable; unsafe, duplicate, malformed, missing, and ambiguous
identities remain visible but cannot navigate.

### Preview-first history retention

**Given** authorized control-server history, **when** the operator previews
local retention cleanup, **then** History shows the cap, current/projected
counts, every affected control/distributed/fleet identity, connected-agent and
issued-token counts, linked distributed states, and the explicit fact that
existing sockets and stored artifact files remain. No mutation occurs until a
current preview is reviewed and explicitly confirmed in an accessible
alertdialog.

Cancel, Escape, and outside dismissal never confirm. Endpoint, API-base,
credential-origin, connection-generation, authorization, or credential-trust
changes invalidate the preview and discard its private token. A conflict keeps
the old consequence list visibly stale and requires a fresh preview. Success
refreshes root history before clearing only URL selections associated with
actual deletions; History filters and unrelated valid state remain unchanged.
Preview IDs, tokens, authorization material, and artifacts are never persisted.

## URL-state contract

All new Recipe Console URLs use the typed, validated schema version `v=1`.

| Field | Allowed value or meaning |
| --- | --- |
| `v` | `1` |
| `experience` | `recipe-console` or `legacy` |
| `view` | `execute`, `monitor`, `analyze`, `tune`, `fleet`, or `advanced` |
| `controlRunId` | Selected control-run identifier |
| `distributedRunId` | Selected distributed-run identifier |
| `agentId` | Selected agent identifier |
| `recipeId` | Selected recipe identifier |
| `commandId` | Selected command identifier |
| `diagnosticSeverity` | Diagnostic severity filter |
| `transport` | Transport filter |
| `historyQuery` | History text query |
| `historyGroup` | History group substring filter |
| `historyRecipeId` | History recipe substring filter; distinct from operational `recipeId` |
| `historyProfile` | History recipe-profile substring filter |
| `failureCategory` | Semantic failure category filter |
| `status` | Run/status filter |
| `from` | Inclusive time-range start |
| `to` | Inclusive time-range end |
| `compareLeft` | Left/baseline run identifier |
| `compareRight` | Right/candidate run identifier |
| `timingMetric` | Selected timing metric |
| `fleetRegion` | Fleet region filter |
| `fleetMapLayers` | Selected fleet-map layer set |
| `legacySurface` | Present only while an advanced legacy route is active |

### Precedence and canonicalization

1. Explicit, valid `v=1` `experience` and `view` state wins.
2. Old `workspace`, `appMode`, `tab`, `advancedSurface`, and `advanced` aliases remain compatibility inputs. During migration they open the exact legacy surface or its documented compatibility route in the [migration register](./recipe-console-migration-register.md).
3. Explicit URL state wins over local personal defaults.
4. Invalid fields fall back visibly; every valid field in the same URL is retained and canonicalized.
5. Committed view, selection, filter, comparison, and legacy-route changes push history. High-frequency time-range or viewport changes replace history.
6. After the final default flip, stale stored legacy navigation cannot override a blank URL's Recipe Console default.
7. Runner-agent launch URLs remain compatible with `mode=control`, `workspace=black-box-runner`, and `tab=local-workbench`. New links put `controlToken` and `agentSessionTicket` in the fragment; bootstrap consumes and immediately scrubs them with `history.replaceState`. Legacy query-token links remain parseable and receive the same immediate scrub.
8. `legacySurface` is removed when leaving an advanced legacy route.

## Local storage rules

Local storage may contain personal defaults only: collapsed panels, last control URL, preferred density, recent recipe profile, bounded saved History-filter presets, and a theme preference if one is introduced. URL state owns shareable operational context. Saved presets use the versioned `rallar-black-box.ui.recipe-console.history-filter-presets.v1` envelope and contain only `historyQuery`, `historyGroup`, `historyRecipeId`, `historyProfile`, `failureCategory`, `status`, `from`, and `to`. They are limited to 12 entries with bounded names and values; explicit URL fields always win until an operator applies a preset.

Never persist secrets, raw credentials, session tickets, large artifact payloads, transient hover state, pointer positions, animation state, or equivalent ephemeral presentation state. Existing redacted draft persistence remains a temporary legacy responsibility until its migration-register owner proves an explicit replacement.

## Artifact compatibility profiles

Artifact validation is profile- and schema-version-aware. These product profiles describe acceptance behavior; they do not introduce a new wire-contract enum.

| Profile | Files and behavior |
| --- | --- |
| Core distributed bundle | `distributed-run.json`, `manifest.json`, and `control-run.json` form the core distributed bundle and support run identity, orchestration state, and manifest analysis. |
| Evidence-enriched bundle | `report.json`, `results.jsonl`, `events.jsonl`, `failures.json`, and `metadata.json` add report, result, event, failure, and provenance evidence. Any of these may be optional according to bundle kind and schema version. |
| Partial/offline bundle | Any parseable supported subset remains analysable. The UI preserves usable evidence and emits visible, file-specific missing/incompatible warnings; absence of an optional evidence file does not invalidate all other evidence. |
| Control-server schema v2 | Core files plus `report.json`, `failures.json`, and `metadata.json` identify v2. Linked/absent `results.jsonl` and `events.jsonl` are explicit optional evidence rather than a v1 downgrade. |
| Export envelope and future schema | The existing `{ artifactSchemaVersion, distributedRunId, generatedAtEpochMs, files }` envelope round-trips without contract changes. A future claimed version retains usable evidence with an explicit unsupported/unknown-version warning. |
| Generic black-box-runner artifact | Remains a separate public profile and is handed to the legacy Shared Test importer; it is never reinterpreted as a distributed-run bundle. |

Browser intake is limited to 24 files, 16 MiB per file, and 48 MiB total.
Duplicate basenames, unsafe paths, unsafe/unbounded URL identities, and malformed
Unicode are rejected or quarantined without replacing the last usable analysis.

The product must not present all eight files as universally required. Unknown versions and malformed present files are distinguished from legitimately absent optional files.

## Ready-State traceability

The quoted test names below are the canonical acceptance evidence. A row is not complete until its named artifact exists and passes; naming it here is not pass evidence. An unavailable configured-service test would remain open even when its wrapper and discovery checks pass. Iteration 12 executed the configured owner, so no row below remains open.

| # | Ready-State condition | Owning iteration | Exact expected evidence |
| --- | --- | --- | --- |
| 1 | The default first screen is distributed recipe execution, not a general command center. | 12 | `tests/playwright/rallar-black-box/recipe-console-shell.spec.ts` — `blank URL opens Recipe Console Execute after the final ready-state flip` |
| 2 | A simulated distributed ACK run can launch three agents and reach Monitor from visible controls without Refresh or legacy navigation. | 4 + launch migration | `tests/playwright/rallar-black-box/recipe-console-execute.spec.ts` — `launches agents and runs a simulated distributed ACK recipe through visible controls` |
| 3 | A live distributed run can be staged, started, monitored, cancelled, and exported when services are configured. | 3-5 | `tests/playwright/rallar-black-box/full-stack-recipe-console-monitor.spec.ts` — `completes the configured live distributed run lifecycle and exports its artifact` |
| 4 | Failures are listed before raw event streams. | 5 | `tests/playwright/rallar-black-box/recipe-console-monitor.spec.ts` — `places the failure verdict and failure list before raw event evidence` |
| 5 | Every failure row links to agent, command, recipe, diagnostic, timeline, and artifact evidence when available. | 5-6 | `tests/playwright/rallar-black-box/recipe-console-monitor.spec.ts` — `opens all available correlated evidence from a failure row` |
| 6 | Artifact import works without a control server connection. | 6 | `tests/playwright/rallar-black-box/recipe-console-analyze.spec.ts` — `imports a partial bundle offline and focuses the first actionable failure` |
| 7 | Timing analysis surfaces command percentiles and RTC stream-specific health. | 7 | `tests/playwright/rallar-black-box/recipe-console-tune.spec.ts` — `shows command percentiles cadence drift drops and backpressure for an RTC stream` |
| 8 | Compare mode shows changed recipes, participants, failures, timings, and received-message deltas. | 7-8 | `tests/playwright/rallar-black-box/recipe-console-tune.spec.ts` — `compares two runs across recipe participant failure timing and receive deltas` |
| 9 | URL state restores selected view, run, filters, comparison, and timing metric. | 2, 8 | `tests/playwright/rallar-black-box/recipe-console-history.spec.ts` — `restores versioned view selection filters comparison and timing metric from a copied URL` |
| 10 | Large event/result lists are bounded or virtualized. | 9 | `tests/playwright/rallar-black-box/recipe-console-scale.spec.ts` — `keeps synthetic large event and result lists bounded responsive and searchable` |
| 11 | Direct Rallar tools exist as advanced diagnostics, not primary navigation. | 11 | `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts` — `keeps direct Rallar diagnostics out of primary navigation and opens them from Advanced` |
| 12 | Existing legacy UI elements remain reachable through advanced/contextual routes, even when hidden from the main flow. | 11 | `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts` — `opens every registered legacy surface from its alias and contextual route` |
| 13 | Hidden legacy routes are not mounted or loaded on the default path unless a documented state-preservation exception requires it. | 1, 11 | `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts` — `default Recipe Console does not load or poll inactive legacy routes except registered stateful exceptions`; `packages/tests/rallar-black-box/legacy-boundaries.test.ts` — `loads every registered legacy experience route dynamically` |
| 14 | Desktop and mobile views are usable without hidden hover-only evidence. | 12 | `tests/playwright/rallar-black-box/recipe-console-accessibility.spec.ts` — `exposes equivalent keyboard touch and persistent evidence at desktop portrait and landscape viewports` |

### Iteration 12 final Ready-State checkpoint — `4f04228`, `aec6e57`

All fourteen rows above pass. Ready-State #1 and #14 pass their exact named
acceptances after the blank-default flip and final accessibility work.
Ready-State #3 passes the separately configured
`npm run test:e2e:rallar-black-box:full-stack:real:distributed` execution 4/4:
visible create/stage/start/Monitor/Cancel/export and strict browser ACK, WS, and
RTC recipes run against fresh Postgres/API/control/SPA services. The complete
deterministic Recipe Console configuration still reports one opt-in live
wrapper skip with the exact prerequisite; that skip is retained as skipped and
is not the #3 pass evidence.

Final qualification passes 196 deterministic browser cases plus that one
explicit skip, blank default 1/1, preserved legacy navigation 29/29,
responsive/accessibility/operational/CSS 48/48, production chunk/Advanced
13/13, and all eight Direction A baselines without updates. Non-browser proof
passes 294/294 focused and 1,568/1,568 complete app tests, a 777-module build,
shared/app/server/API type and Deno checks, control-server 79/79, PGlite 13/13,
real PostgreSQL prefix/planner 3/3, and an up-to-date 15-migration schema.
Independent final review is clean.

The cutover changes only experience selection. Explicit legacy aliases, old
deep links, Advanced/contextual handoffs, and runner-agent launches remain
operational. Ten safe legacy owners remain lazy/unmounted and twelve documented
stateful exceptions remain mounted only inside active `LegacyExperience`.
Nothing is retired or newly hidden from the preserved legacy navigation. No
existing public export was removed or changed, and no existing control-server
contract changed; one deterministic request-ID helper export is additive.

### Iteration 5 evidence checkpoint — `42eedae`

- Ready-State #4 is satisfied by the passing exact failure-first Monitor
  acceptance, and Ready-State #5 is satisfied by the passing exact
  selected-failure correlation acceptance. The code-backed Monitor also covers
  current/partial/last-known/offline truth, running/pass/fail/timeout/cancelled
  and reconnect transitions, bounded secondary evidence, visible armed Cancel,
  artifact Load/Export, copied run/evidence URLs, and the selected legacy Runs
  handoff.
- The qualified exit passed 229/229 focused tests, 708/708 app tests across 72
  files, shared/app typechecks, a 507-module build and chunk assertion, 100
  Recipe Console browser tests plus one configured-live skip, 28/28 legacy
  navigation/ticket tests, and 57/57 control-server tests. Seven recorded
  Important UI/state review findings were closed with RED/GREEN coverage.
- Ready-State #3 remains open and unpassed. Its canonical full-stack owner is
  present and discovered, but Postgres-backed services were unavailable; the
  no-environment wrapper produced exactly one skip for:
  `Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
  apps/rallar-black-box-control-server, and apps/rallar-black-box available.`
- The in-app Browser was unavailable exactly as `No browser is available`;
  controlled Playwright/System Chromium is the recorded fallback. No default,
  primary-navigation, legacy-row visibility, mount-policy, or workflow cutover
  changed, and both legacy workflow rows remain available.

### Iteration 6 evidence checkpoint — `f96b5b4`, `abe257e`, `9b07330`, `47c332d`

- Ready-State #6 is satisfied by the passing canonical acceptance
  `tests/playwright/rallar-black-box/recipe-console-analyze.spec.ts` —
  `imports a partial bundle offline and focuses the first actionable failure`.
  Local import reads no artifact endpoint; the independent root control
  snapshot query may remain active.
- The qualified exit passed 226/226 focused tests, 786/786 app tests across 81
  files, shared-test/app typechecks, a 551-module production build and chunk
  assertion, 119 Recipe Console browser tests plus one configured-live skip,
  28/28 legacy navigation/ticket tests, and 57/57 control-server tests. The
  Analyze matrix covers loose files and the export envelope, input safety,
  retained evidence, URL-backed search, responsive/accessibility states, and
  both CSS load orders.
- Ready-State #3 remains open and unpassed. Its canonical full-stack owner is
  present and discovered, but Postgres-backed services were unavailable; the
  no-environment wrapper produced exactly one skip for:
  `Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
  apps/rallar-black-box-control-server, and apps/rallar-black-box available.`
- The in-app Browser was unavailable exactly as `No browser is available`;
  controlled Playwright/System Chromium is the recorded fallback. No default,
  primary-navigation, legacy-row visibility, mount-policy, workflow cutover,
  public export, control-server contract, or rollback route changed.

### Iteration 7 evidence checkpoint — `cc17169`, `382df72`

- Ready-State #7 is satisfied by the passing exact acceptance
  `tests/playwright/rallar-black-box/recipe-console-tune.spec.ts` —
  `shows command percentiles cadence drift drops and backpressure for an RTC
  stream`. It is driven by a retained real artifact and exposes command
  min/P50/P95/P99/max, mean/spread/outliers, RTC frame disposition, cadence,
  drift, late frames, backpressure/in-flight drops, and specific slow-agent
  provenance without invented values.
- The bounded comparison evidence for Ready-State #8 is satisfied by
  `compares two runs across recipe participant failure timing and receive
  deltas`. The explicit v1 baseline/candidate pair also shows selected
  performance deltas and compatibility warnings. The migration proof
  `compares two runs and emits explicit candidate timing changes without
  mutation` verifies validated copyable JSON Patch/diff output, source
  immutability, and zero Tune mutation requests.
- The qualified exit passed 247/247 focused tests. The complete 883-test app
  suite across 93 files is qualified green: 881 passed in the restricted
  sandbox and the only two denied IPC/loopback cases then passed in their exact
  nine-test file with required permission. Shared-test TypeScript and all seven
  Deno entries, app TypeScript, a 580-module build, chunk proof, 137 available
  Recipe Console browser tests, 28/28 legacy navigation/ticket tests, and 57/57
  control-server tests passed. One configured-live browser owner was skipped.
  Independent shared, app/state, browser/accessibility, and cutover re-reviews
  report no remaining Critical or Important finding.
- The in-app Browser was unavailable exactly as `No browser is available`;
  controlled Playwright/System Chromium is the fallback. The configured
  live/Postgres owner was skipped, not passed, because: `Set
  RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
  apps/rallar-black-box-control-server, and apps/rallar-black-box available.`
- Ready-State #9 remains open for Iteration 8 copied-URL history/filter/
  comparison restoration. No default, primary-navigation, legacy visibility,
  legacy mount policy, control-server contract, deep link, rollback route, or
  workflow cutover changed. No existing public export was removed, renamed, or
  broken; the shared tuning exports are additive.

### Iteration 8 Task 7 evidence checkpoint — `7256379`

- Preview-first retention composition, token-free consequence projection,
  exact whitespace/bidi-safe IDs, accessible confirmation/cancellation, stale
  conflict truth, authorization withholding, and refresh-before-selection
  reconciliation are code-backed under the existing lazy Tune/History route.
- Focused retention/client/History/Tune/build-boundary validation passed
  121/121. App TypeScript, the 616-module production build, and reciprocal
  experience-chunk assertion passed. Independent state/race,
  UI/accessibility, and evidence-traceability reviews report no remaining
  Critical or Important issue.
- Canonical real-browser copied-link, retention, responsive, keyboard,
  reduced-motion, CSS-isolation, overflow, and inactive-unmount acceptance
  remain Task 8 work and are not claimed here. No legacy row is hidden or cut
  over; the default, deep links, rollback routes, mount policies, public
  exports, and existing control-server contracts remain unchanged.

### Iteration 8 qualified exit — `fd9055e`, `f762749`

- Ready-State #8 remains satisfied by the exact Tune comparison test and now
  includes discoverable History Baseline/Candidate actions, saved presets, and
  post-cleanup selective comparison reconciliation without a second compare
  implementation.
- Ready-State #9 is satisfied by
  `restores versioned view selection filters comparison and timing metric from
  a copied URL`. It restores the operational run, all eight History filters,
  explicit comparison, and timing metric; copied links and back/forward retain
  the same typed state.
- `previews retention impact before confirmed destructive cleanup` proves the
  unchanged destructive default, optional authorization-first preview,
  token-free consequences, explicit guarded confirmation, refresh-before-URL
  reconciliation, post-confirm token absence, actual deleted IDs, and exact
  retained filters through copy/reset/back/forward. Cancel and `409` drift do
  not issue or repeat destructive cleanup.
- Fresh qualification passed 330/330 focused tests, 1,066/1,066 app tests,
  shared/app TypeScript, seven shared Deno entries, the 616-module build and
  chunk assertion, 79/79 control-server tests, 147 Recipe Console browser
  cases with one configured-live skip, and 28/28 legacy navigation/ticket
  cases. Independent state, UI/accessibility, traceability, and final visual
  reviews report no remaining Critical or Important issue.
- The in-app Browser confirmed desktop Execute and portrait/landscape Tune
  offline states, contained widths, intentional internal landscape scrolling,
  and no warning/error logs. System Chromium owns the executable keyboard,
  touch, reduced-motion, operational, retention, and CSS-isolation matrix.
- Ready-State #3 remains open. Its live/Postgres owner is skipped, not passed,
  for exactly: `Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed
  apps/api-v1, apps/rallar-black-box-control-server, and
  apps/rallar-black-box available.`
- No default, primary-navigation, legacy visibility/mount, deep link, rollback,
  public export, existing control-server contract, or workflow cutover changed.

### Iteration 9 Task 6 Monitor scale checkpoint — `8c630fc`

- Monitor's former fixed prefixes are now explicit accessible Previous/Next
  windows for main failures, agents, recipes, readiness, diagnostics,
  timeline, events, and composites plus inspector command evidence, failure
  destinations, and diagnostic links. Exact ranges and outside-window totals
  remain visible, stable source identities traverse without gaps or duplicates,
  closed disclosures mount no hidden retained rows, and fingerprint/polling
  changes reset or recover focus without changing v1 URL state.
- Indexed Control selection and agent-board consumers reuse exact-revision
  topology on unchanged polls, avoid repeated global traversal, and preserve
  duplicate/order/object-identity/cross-control/synthetic behavior. Inactive
  Analyze still performs zero run-option traversal or search work. Failure-
  first order, current/last-known authority, existing operations, selected-
  evidence correlations, exact identifiers, public exports, and control-server
  contracts remain unchanged.
- The settled focused gate passed 226/226 tests across 11 files: 28 query,
  24 structure, 10 shared topology, 3 cache, 69 API, 27 Monitor state, 17 board,
  26 selection, 1 provider, 13 main-window, and 8 inspector-window. App
  TypeScript, the 655-module production build, reciprocal experience-chunk
  assertion, and `git diff --check` passed; only the existing greater-than-
  500-kB advisory remained. Indexed-consumer, browser, and final exit
  re-reviews report no open Critical or Important finding.
- Stable-source browser proof passed 11/11 combined new/existing Monitor cases
  and 6/6 responsive/accessibility and CSS-isolation cases. The new large-
  fixture owner passed 4/4 across 1440×900 desktop, genuine-touch 430×932
  portrait, genuine-touch 932×430 landscape, keyboard/focus, reduced motion,
  operational states, bounded DOM, exact forward/back traversal, URL stability,
  and Direction A containment.
- Two earlier browser attempts overlapped live consumer or neutral binding-file
  edits and were unavailable as product verdicts; both reran fully green on
  stable source. A direct `tsx --test` UI attempt was unavailable because Node
  cannot load CSS modules; authoritative Vitest passed. The in-app Browser was
  unavailable exactly as `No browser is available`; Playwright/System Chromium
  is fallback evidence, not an in-app Browser pass.
- The configured-live owner remains skipped, not passed, for exactly: `Set
  RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
  apps/rallar-black-box-control-server, and apps/rallar-black-box available.`
  Ready-State #10 and parent Iteration 9 remain open for Tasks 7–9, canonical
  scale acceptance, remaining heartbeat proof, and final profiling. No
  primary/default navigation, legacy visibility/mount, deep link, rollback,
  public/control contract, or cutover changed, and no legacy row was hidden.

### Iteration 9 qualified scale exit — `58070bf` through `f8cef95`

- Ready-State #10 is satisfied by the passing exact production acceptance
  `keeps synthetic large event and result lists bounded responsive and
  searchable`. It covers 12,000 events, 3,000 results, 5,000 History pairs,
  5,000 Tune pairs, 24,002 knobs, Execute/Monitor/retention pressure paths,
  exact first/middle/last traversal, and bounded mounted DOM at desktop,
  tablet, touch portrait, and touch landscape viewports.
- Analyze performs one shared parsed pipeline pass, visits eight files, parses
  six JSON documents, passes two JSONL files once, parses exactly 15,000 rows,
  derives in its worker, and mounts no more than 64 results. History mounts no
  more than 80 rows; every other proven pressure list mounts no more than 100.
  Tune derives performance for only the explicit pair and advances an event-
  loop heartbeat before acceptance, after paint, and while the snapshot RPC is
  held. Closed searchable popups and disclosures are unmounted.
- Same-machine profiling at 15,000 rows improved model median 114.584→73.337
  ms, approximate p95/max 115.246→79.725 ms, search median 0.870→0.860 ms,
  and retained model heap median 10,678,856→10,028,264 bytes. These remain
  advisory; exact work/cardinality and browser gates own acceptance. Canvas is
  deferred because measured pressure was rows/options and repeated derivation,
  not a dense plot.
- Fresh qualification passed 1,385/1,385 app tests, shared/app TypeScript,
  seven shared Deno entries, a 699-module build and reciprocal chunk proof,
  169 available Recipe Console browser cases, and 28/28 legacy navigation/
  ticket cases. Four independent reviews are clean after focused fixes for
  selector fidelity and live-shrink inspector focus. Direction A remains
  unchanged.
- The in-app Browser was unavailable exactly as `No browser is available`
  with an empty browser list; Playwright/System Chromium is fallback evidence.
  The configured-live owner is skipped, not passed, for exactly: `Set
  RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
  apps/rallar-black-box-control-server, and apps/rallar-black-box available.`
  Ready-State #3 remains open for that configured execution.
- No default, primary navigation, legacy visibility/mount, deep link, rollback,
  public export, existing control contract, or cutover changed. At this
  checkpoint Fleet,
  Advanced diagnostics, accessibility polish, and the default flip remain
  Iterations 10–12 work.

### Iteration 10 qualified Fleet exit — `0088be0`, `3ab86a9`

- The canonical Fleet acceptance passes:
  `restores fleet filters and map layers and links a failure signature to its
  run evidence`. From visible controls an operator can identify repeatedly
  failing agents and regions, distinguish timing correlation, traverse the
  complete bounded live board/heatmap/region/failure/timing evidence, and
  reach exact agent, run, History, Analyze, report, and artifact evidence.
- The shared evidence contract tolerantly validates optional reports, keeps
  malformed/unsupported/duplicate truth explicit, preserves live and
  historical authority separately, indexes complete browseable collections,
  and resolves geography only from explicit coordinates or documented
  datacenter/region lookups. The SVG is secondary and bounded; routes require
  explicit target-agent evidence and two resolved endpoints. Opaque artifact
  references are never treated as URLs.
- `fleetRegion` and `fleetMapLayers` restore exactly across copy, reload, and
  every committed back/forward state. The Fleet route is lazy and unmounted
  while inactive, imports no legacy panel, consumes the single root query, and
  adds no poll or credential owner. Direction A passes desktop, tablet,
  genuine-touch portrait/landscape, keyboard/focus, 44px targets, reduced
  motion, long/bidi evidence, operational states, zero document overflow,
  both CSS load orders, chunk separation, and five reviewed baselines.
- Fresh qualification passed 279/279 focused tests across 18 files, shared/app
  TypeScript, shared configured and direct Fleet Deno checks, the 758-module
  production build and reciprocal chunk assertion, and 1,472/1,472 complete
  app tests across 139 files. Browser evidence passes Fleet 7/7, visual
  no-update 3/3, broader Recipe Console 65/65, the complete Recipe Console
  configuration with 179 passed and one exact configured-live skip, legacy
  Fleet/navigation 33/33, and existing-owner regressions 28/28. Independent
  reviews report no remaining Critical or Important issue.
- The in-app Browser was unavailable exactly as `Browser runtime unavailable
  after setup failure: Cannot redefine property: process`; terminal Playwright
  is fallback evidence. The configured live/Postgres owner remains skipped,
  not passed, for exactly: `Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-
  backed apps/api-v1, apps/rallar-black-box-control-server, and
  apps/rallar-black-box available.` Ready-State #3 remains open.
- No legacy Fleet row was hidden or cut over. Its `fleet`, `fleet-report`, and
  `fleet-reports` links, active-only mount, rebuild/export behavior, rollback
  URL, and public/control contracts remain operational. No default changed.
  At this checkpoint Iterations 11–12 retained Advanced/contextual diagnostics,
  safe lazy legacy ownership, final accessibility, and blank-URL default-flip
  work. The qualified Iteration 11 result follows.

### Iteration 11 qualified Advanced diagnostics exit — `5ed54fc` through `78e2c13`

- Ready-State #11 is satisfied by the exact passing acceptance `keeps direct
  Rallar diagnostics out of primary navigation and opens them from Advanced`.
  The six primary destinations remain Execute, Monitor, Analyze, Tune, Fleet,
  and Advanced; Advanced categorizes all 13 direct diagnostics plus nine
  workflow/legacy fallback leaves without importing legacy React.
- Ready-State #12 is satisfied by `opens every registered legacy surface from
  its alias and contextual route`. All 22 catalog leaves, every registered
  alias, `advancedSurface`/`advanced` child, runner-agent launch path, visible
  owner, and rollback route pass. Selected Monitor failures open the exact
  Auth, WebSocket, RTC Diagnostics, Groups/Clients, or Rallar Server tool with
  bounded context and return to the same selected view/run.
- Ready-State #13 is satisfied by `default Recipe Console does not load or
  poll inactive legacy routes except registered stateful exceptions` and the
  exact structure/chunk owner. Ten safe targets are distinct dynamic entries
  and unmount on exit. Twelve explicitly documented stateful exceptions remain
  hidden-mounted only while `LegacyExperience` is active; a cold Recipe Console
  route loads, mounts, subscribes, and polls none of them.
- Outbound/return context is versioned, same-origin on focus restoration,
  provider allow-listed, UTF-8 bounded, and secret-free. It carries only
  application/workspace/group plus safe run/agent/recipe/command/transport
  identity. It never grants operation authority, persists credentials, or
  accepts an arbitrary return URL.
- Fresh qualification passes 1,564/1,564 app tests, shared/app TypeScript,
  seven shared Deno entries plus the direct classifier/module check, a
  776-module build, reciprocal chunk assertion, 190 complete Recipe Console
  browser cases, 30 preserved legacy cases, 31 responsive/CSS cases, and four
  no-update Advanced baselines. One Recipe Console configured-live case and
  two exhaustive legacy cases are skipped, not passed, for exactly: `Set
  RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
  apps/rallar-black-box-control-server, and apps/rallar-black-box available.`
- The in-app Browser attempt remains unavailable exactly as `Browser runtime
  unavailable after setup failure: Cannot redefine property: process`;
  terminal Playwright is fallback evidence. Independent reviews report no
  remaining Critical or Important finding. Their final production-return
  builder finding is closed in `78e2c13`: production and Advanced callers now
  share the same neutral bounded serializer, canonical `legacySurface` wins a
  saturated return budget, and exact unit/browser regressions pass re-review.
- No legacy row, alias, public export, existing control contract, destructive
  behavior, or default changed. `DEFAULT_APP_EXPERIENCE` remains `legacy`.
  Iteration 12 owns Ready-State #1 and #14, the unavailable #3 execution, final
  accessibility repair, and the blank-URL default flip.
