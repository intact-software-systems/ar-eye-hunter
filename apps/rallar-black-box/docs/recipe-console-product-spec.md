# Recipe Console Product Spec

Status: canonical product contract; Ready-State #4–#7 and the bounded comparison evidence for #8 are code-backed through Iteration 7
Evidence date: 2026-07-12

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
- No control protocol, artifact contract, shared-test public export, control-server endpoint, or app import-path break.
- No deletion or retirement of legacy surfaces in this strangler project.
- No generic admin-console redesign of direct Auth, Groups, WS, RTC, Data, CRDT, Media, Server, or tracing tools.
- No automatic mutation of recipes. Tuning may produce explicit copyable candidate changes, but applying them is a separate deliberate action.

## Observable acceptance stories

### Simulated ACK execution

**Given** Recipe Console is using the simulated provider and a schema-valid ACK recipe is visible in the catalog, **when** an operator selects the recipe, resolves its targets, creates the run, stages it, and starts it through visible controls, **then** the UI shows the resulting run identity, progress, and terminal verdict without requiring JSON editing.

### RTC stream evidence

**Given** configured RTC-capable agents and an RTC stream recipe, **when** an operator stages and runs the recipe, **then** Monitor and Tune show planned/completed/failed/dropped frames, achieved cadence, drift, late frames, send-duration percentiles, and backpressure/in-flight-drop evidence linked to affected agents.

### Target-resolution failure before staging

**Given** a recipe whose required targets include missing, stale, offline, duplicate, wrong-group, or capability-incompatible agents, **when** the operator resolves targets, **then** Execute explains each non-targetable agent and blocks staging until the readiness problem is corrected or the target selection is changed.

### Offline artifact analysis

**Given** no control-server connection and a partial or complete supported artifact bundle, **when** the operator imports the files locally, **then** Analyze retains all usable evidence, warns visibly about missing or incompatible files, and focuses the first actionable failure with likely cause, next action, and evidence source.

The same workspace accepts the existing control-server export envelope, keeps
artifact bytes only in bounded memory, searches normalized failure/result/event/
diagnostic evidence through v1 URL filters, exports without a second request,
and visibly rejects generic black-box-runner artifacts to the preserved Shared
Test importer. Unknown schema versions and malformed optional evidence remain
inspectable and can never be presented as a supported bundle; the artifact's
claimed run outcome remains visible beside the incompatibility warning.

### Run comparison and candidate tuning

**Given** two compatible run snapshots or artifact bundles, **when** the operator selects them as comparison inputs, **then** Tune shows recipe, participant, failure, timing, and received-message deltas and produces explicit candidate timing changes without silently mutating either recipe.

### Server history and saved filters

**Given** server run history, **when** the operator opens Tune, **then** current
timing and candidate evidence remains first and a bounded History ledger follows
with explicit root/fallback/stale/partial provenance, URL-backed semantic
filters, saved local filter presets, safe Baseline/Candidate handoff, exact
filtered/rendered/omitted counts, and no artifact-derived synthetic server row.
At most 100 rows render before Iteration 9 windowing; unsafe, duplicate,
malformed, missing, and ambiguous identities remain visible but cannot navigate.

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
7. Runner-agent launch URLs remain compatible with `mode=control`, `workspace=black-box-runner`, and `tab=local-workbench`. Fragment `agentSessionTicket` consumption and immediate fragment scrubbing remain compatible.
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

The quoted test names below are the canonical acceptance evidence. A row is not complete until its named artifact exists and passes; naming it here is not pass evidence. An unavailable configured-service test remains open even when its wrapper and discovery checks pass.

| # | Ready-State condition | Owning iteration | Exact expected evidence |
| --- | --- | --- | --- |
| 1 | The default first screen is distributed recipe execution, not a general command center. | 12 | `tests/playwright/rallar-black-box/recipe-console-shell.spec.ts` — `blank URL opens Recipe Console Execute after the final ready-state flip` |
| 2 | A simulated distributed ACK run can be completed from visible controls. | 4 | `tests/playwright/rallar-black-box/recipe-console-execute.spec.ts` — `runs a simulated distributed ACK recipe through visible controls` |
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
| 13 | Hidden legacy routes are not mounted or loaded on the default path unless a documented state-preservation exception requires it. | 1, 11 | `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts` — `default Recipe Console does not load or poll inactive legacy routes except registered stateful exceptions`; `packages/tests/rallar-black-box/app-structure.test.ts` — `legacy routes resolve through dynamic imports only` |
| 14 | Desktop and mobile views are usable without hidden hover-only evidence. | 12 | `tests/playwright/rallar-black-box/recipe-console-accessibility.spec.ts` — `exposes equivalent keyboard touch and persistent evidence at desktop portrait and landscape viewports` |

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
