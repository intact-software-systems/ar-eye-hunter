# Recipe Console Iteration 2 Fidelity Ledger

Status: Iteration 2 visual direction preserved; Execute, live Monitor, and
offline Analyze are qualified through Iteration 6, while Tune remains seeded

Evidence date: 2026-07-12
Implementation heads: `a397642` (Iteration 2), `8d44a99`, `bddde71`
(Iteration 4 Execute), `42eedae` (Iteration 5 live Monitor fidelity proof),
`f96b5b4`, `abe257e`, `9b07330`, `47c332d` (Iteration 6 Analyze)
Approved direction: Signal Ledger (Direction A)

This ledger preserves the approved Iteration 2 visual contract and its
historical seeded Monitor/Tune evidence, then records the Iteration 4 Execute,
Iteration 5 live Monitor, and Iteration 6 Analyze baseline advances. It does not claim the
unavailable configured live/Postgres acceptance, a legacy navigation hide, or
the Iteration 12 default flip.

## Iteration 4 Execute fidelity addendum

Direction A remains unchanged. The executable Execute baseline now uses a
deterministic mocked-live two-agent fixture: `execute-control-a`, `execute-agent-a`,
`execute-agent-b`, group `rallar-black-box/default/rallar-black-box-room`, and
the repository `RTC Realtime Stability` recipe. The approved command bar,
labeled rail, parallel recipe/target work planes, contextual inspector, and
bottom action band remain intact; repository and control truth replace the
Iteration 2 preview copy.

Execute now exposes the real catalog/profile badges, every target status and
blocker reason, preflight requirements, a read-only raw manifest, authoritative
run state, and only the currently valid Resolve/Create/Stage/Start/Cancel/
Refresh/Export actions. Resolve is the only initial mutation; no preview action
or editable manifest remains. Desktop and short landscape keep every target
status visible. Portrait uses a labeled, focusable, keyboard-scrollable target
region rather than clipping or hiding evidence.

The refreshed Darwin Execute baseline at
`../../../tests/playwright/rallar-black-box/recipe-console-concept-fidelity.spec.ts-snapshots/signal-ledger-execute-desktop-chromium-darwin.png`
was inspected at original detail. The complete Recipe Console configuration
passes 89 tests with one configured-live skip. The in-app Browser was
unavailable exactly as `No browser is available`, so Playwright/System Chromium
is the recorded fallback, not an in-app Browser pass. Desktop, tablet, portrait,
landscape, keyboard-only paths, 44px targets, reduced motion, focus restoration,
contained scrolling, operational states, and actual Execute CSS in both load
orders pass.

## Iteration 5 live Monitor fidelity addendum

Direction A remains unchanged. Commit `42eedae` completes the controlled
browser fidelity plus full-stack harness/discovery proof for a Monitor now
sourced from deterministic live control and distributed-run snapshots, rather
than the Iteration 2 Monitor seed. The canonical fixture selects control run
`monitor-control-live`, distributed run `monitor-distributed-live`, recipe
`monitor-later-failure`, receiver `monitor-agent-receiver`, and command
`monitor-start-receiver`. It projects authoritative connection and reconnect
fields as well as complete, partial, last-known, offline, running, passed,
failed, timed-out, cancelled, and deleted-run states.

The failed desktop and portrait Darwin Monitor baselines were refreshed and
inspected at original detail. Their SHA-256 values are respectively
`b0ec35c58a3b06d3a2722e5987f66035984330e8360fe5e8d9d531aea2b017b6`
and
`39706ec892071190be00b782515a68facc442bffa2f55f1a91da3dae577b7eff`.
Controlled QA covers 1440×900 desktop, 900×900 tablet, 430×932 portrait, and
932×430 short landscape; keyboard-only evidence and Cancel paths; focus
trap/restoration; representative 44px targets; reduced motion; zero document
overflow; bounded matrix/action scrolling; and live Monitor CSS in both load
orders. The complete Recipe Console configuration passes 100 tests with one
additional exact configured-live skip.

The in-app Browser was attempted first and was unavailable exactly as
`No browser is available`; Playwright/System Chromium is fallback evidence,
not an in-app Browser pass. The configured Postgres lifecycle remains skipped,
so Ready-State #3 remains open. Both owning legacy workflow rows, old deep
links, and their rollback paths remain operational and visible; Iteration 5
makes no cutover, navigation hide, or default-experience flip.

## Iteration 6 offline Analyze fidelity addendum

Direction A remains unchanged. Analyze now follows the Signal Ledger order:
bounded local/Control source actions, first actionable failure and fix,
likely-causal quality/file inventory, performance, searchable evidence, and
issue-ready Markdown. The first visible region answers what failed, who is
affected, what to inspect, and how to verify without making raw JSON the
primary path.

Controlled Playwright/System Chromium QA covers 1440×900 desktop, 900×900
tablet, 430×932 portrait, and 932×430 short landscape. Tablet and portrait
captures were inspected at original detail. Portrait preserves failure
priority and a 48px selection dock above the six-item navigation; the inspector
is absent until explicitly opened. All visible Analyze actions are at least
44px, horizontal document overflow is zero, short-landscape focus restores on
Escape, reduced motion disables transitions/animations, and computed Analyze
styles remain identical across cold, legacy-first, and legacy-round-trip load
orders.

The complete Recipe Console configuration passes 119 available tests with one
configured-live skip; the focused Analyze owners pass 19/19 including future
schema, bounds, exhaustive search, late-response, keyboard picker, actual drop,
and activated legacy-handoff proof. The in-app Browser was
unavailable exactly as `No browser is available`, so this is fallback evidence,
not an in-app Browser pass. No screenshot creates a new visual direction;
Direction A remains the approved hierarchy and repository artifact truth owns
the displayed copy and data.

## Controlled environment

| Item | Value |
| --- | --- |
| Worktree | `tmp/worktrees/rallar-black-box-spa` |
| Branch | `codex/rallar-black-box-spa-reimplementation` |
| Host | Darwin 25.5.0 arm64 |
| Node | 26.5.0 locally; CI Node 24 remains a separate compatibility gate |
| Playwright | 1.61.1, Chromium project, light color scheme, `en-US`, UTC, device scale 1 |
| Seed URL | `/?provider=simulated&v=1&experience=recipe-console&view=<view>` |
| Pixel policy | Exact screenshots run on controlled Darwin with a 1% maximum changed-pixel ratio. Semantic and geometry assertions execute before the explicit non-Darwin pixel skip. |

## Approved concepts and executable captures

Every pair below was inspected at original detail during its qualifying pass.
The concepts govern composition; repository fixtures and deterministic
derivations govern copy and data. The Monitor executable captures are the
Iteration 5 refreshes; the native concepts remain the approved Iteration 2
visual contract.

| State | Approved native concept | Executable Darwin baseline | Comparison verdict |
| --- | --- | --- | --- |
| Execute desktop | `docs/recipe-console-concepts/iteration-2-signal-ledger-execute-desktop.png` (1586×992) | `../../../tests/playwright/rallar-black-box/recipe-console-concept-fidelity.spec.ts-snapshots/signal-ledger-execute-desktop-chromium-darwin.png` (1440×900) | Hierarchy retained: command bar, labeled 184px rail, parallel recipe/target planes, persistent details inspector, and bottom action band. Intentional data/copy differences are listed below. |
| Live failed Monitor desktop | `docs/recipe-console-concepts/iteration-2-signal-ledger-monitor-failed-desktop.png` (1586×992) | `../../../tests/playwright/rallar-black-box/recipe-console-concept-fidelity.spec.ts-snapshots/signal-ledger-monitor-failed-desktop-chromium-darwin.png` (1440×900, Iteration 5 refresh) | Failure-first order, ruled ledger, matrix, secondary timeline, and 360px contextual evidence rail retained. Deterministic live control/distributed-run failure evidence replaces the historical seed and illustrative concept rows. |
| Live Monitor portrait | `docs/recipe-console-concepts/iteration-2-signal-ledger-monitor-portrait.png` (851×1847) | `../../../tests/playwright/rallar-black-box/recipe-console-concept-fidelity.spec.ts-snapshots/signal-ledger-monitor-portrait-chromium-darwin.png` (430×932, Iteration 5 refresh) | Verdict → failures → contained matrix → timeline order, persistent `Swipe phases`, 48px selection dock, and 64px six-item bottom navigation retained. Inspector is unmounted until the sheet opens. |
| Tune short landscape | `docs/recipe-console-concepts/iteration-2-signal-ledger-tune-landscape.png` (1847×851) | `../../../tests/playwright/rallar-black-box/recipe-console-concept-fidelity.spec.ts-snapshots/signal-ledger-tune-landscape-chromium-darwin.png` (932×430) | Compact rail and 52/48 matrix/timing split retained. The real command-duration distribution replaces invented stream metrics. |

## Fidelity decision ledger

| Dimension | Evidence and decision |
| --- | --- |
| Copy and data truth | **Intentional, explained deviation.** Execute selects the real `RTC Realtime Stability` fixture and the deterministic mocked-live two-agent state recorded in the Iteration 4 addendum. Monitor now selects deterministic live control/distributed-run truth recorded in the Iteration 5 addendum. Repository/control evidence governs both surfaces; neither repeats the concepts' illustrative ACK recipe or 8/8 target set. Tune alone retains its separately qualified Iteration 2 seed. |
| Historical Iteration 2 Monitor truth | The original canonical `failed-command` seed rendered distributed run `seed-failed-command`, control run `seed-control-failed-command`, recipe `seed-rtc-recipe`, and one of two agents failed. The two rows were `SYNTHETIC_RECIPE_FAILED` and `SYNTHETIC_ASSERTION_FAILED`; both said `Receiver did not observe the RTC payload.` The command-correlated row used `seed-agent-b` and `seed-start-receiver`. This remains concept-history evidence, not the current Monitor source. |
| Iteration 5 live Monitor truth | The deterministic fixture renders control run `monitor-control-live`, distributed run `monitor-distributed-live`, recipe `monitor-later-failure`, sender/receiver agent evidence, and failure `MONITOR_EXPECTED_PAYLOAD_MISSING` on `monitor-start-receiver`. The fixture changes authoritative snapshots to prove disconnect → reconnect, complete/partial/last-known/offline recovery, operational run transitions, bounded events, cancellation, artifact operations, deletion, and late-response rejection. |
| Tune truth | The canonical `high-latency-rtc` seed is visibly **Passed**. Agent means are 112.5, 1,010, and 1,190 ms; P50 is 1,010 ms and P95/P99/Max are 1,190 ms. Source stage/start pairs remain 95/130, 980/1,040, and 1,120/1,260 ms. Cadence, drift, disposition, and backpressure say unavailable because the fixture has no RTC timeline evidence. |
| Layout and hierarchy | Edge-to-edge shell, persistent command band, exact six-destination order, continuous ruled work planes, one contextual inspector, and failure-before-raw-evidence ordering match the approved direction. There is no centered dashboard or card wall. |
| Typography | System/Inter-compatible sans typography, 18px route/section hierarchy, compact 12–14px evidence text, and monospace/tabular machine IDs and durations reproduce the concept's dense operational register. Sentence case is retained; machine codes alone use uppercase. |
| Palette and statuses | Scoped cool canvas, white surfaces, cobalt selection/action, and distinct passed/failed/warning/stale/partial/disabled roles use the approved tokens. Every operational state includes a label and shape/icon; no verdict depends on color alone. Hard stale evidence remains visible. |
| Icons | One code-native outline SVG family is used. Navigation retains text; icon-only refresh/copy controls have accessible names and tooltips. There is no emoji or rasterized UI text. |
| Control geometry | Desktop controls remain compact; every representative portrait command, route, recipe, inspector, segmented, and Advanced compatibility target is at least 44×44px. Bottom-navigation targets have 8px separation. The optional URL feedback occupies its own 44px context row and cannot cover work content. |
| Responsive transformation | 1440×900 desktop uses a 184px rail and 352/360px inspector. At 900×900 the 64px rail remains and the 360px inspector overlays without squeezing work. The 430×932 portrait uses one work scroller, the selection dock, bottom navigation, one modal-sheet inspector, and contained horizontal matrix scrolling. The 932×430 landscape uses a 48px command bar, 60px rail, 12px divider, bounded matrix scrolling, and zero document overflow on both axes. |
| Keyboard and focus | Primary navigation has one roving tab stop; arrows/Home/End move focus and Enter/Space activate. Tune handles all four arrows without opening inspection. Live Monitor opens failure evidence and initiates armed Cancel without a pointer; overlay/sheet focus is trapped, Escape closes, and focus returns to the invoking failure or Cancel control. |
| Motion | Interaction transitions stay bounded; reduced-motion emulation resolves inspector transition duration to `0s` and removes travel/repeated emphasis without hiding state. |
| CSS isolation | Tokens/reset are scoped under `.recipe-console`; feature styles are CSS Modules. The reverse-load-order fixture proves representative Recipe Console and legacy controls, tables, forms, statuses, dialog geometry, and live Monitor styling are stable in both orders. No broad legacy selector is required by the new shell. |
| Experience isolation | Recipe Console and Legacy Experience are mutually exclusive lazy subtrees. An explicit Recipe Console production entry requests its own hashed JS/CSS and no LegacyExperience chunk; a legacy entry does the inverse. The fixture is absent from both executable closures. |

## URL and operational proof

- Blank URLs, explicit legacy URLs, and old aliases still open legacy.
- Explicit Recipe Console URLs canonicalize to `v=1`; invalid fields fall back
  visibly while valid and unknown-safe fields survive.
- Sensitive query and fragment keys are scrubbed before initial or popstate
  replacement and before push/copy operations.
- All six destinations push and restore through back/forward. A popstate to an
  exact legacy deep link is not rewritten by the departing Recipe Console.
- Execute actions are the guided live Resolve/Create/Stage/Start/Cancel/Refresh/
  Export controls. A mutation is unavailable unless its authoritative state,
  current target evidence, arming phrase, and credential policy permit it.
- Live Monitor keeps control-run and distributed-run selection in the URL,
  restores copied deep links, and hands an exact selected run to legacy Runs.
- Empty, offline, partial, last-known, disconnected/reconnected, running,
  passed, failed, timed-out, cancelled, deleted, and unavailable states preserve
  known evidence where valid and provide text-plus-shape semantics.

## Exploratory Browser QA

The in-app Browser was attempted first for the current Iteration 5 pass. It was
unavailable exactly as `No browser is available`. This is recorded as
unavailable, not passed; controlled Playwright/System Chromium is the fallback.
The earlier Iteration 2 attempt returned `Browser is not available: iab` and an
empty availability list; that result remains historical rather than being
rewritten as current evidence.

| Flow / viewport | Fallback evidence |
| --- | --- |
| Live Monitor Iteration 5, 1440×900 | The refreshed failed baseline retains failure-first ordering, live verdict/control freshness, agent-phase truth, bounded secondary evidence, and the 360px inspector. Running/pass/fail/timeout/cancelled, offline/partial/last-known, disconnected/reconnected, deletion, artifact, and Cancel states are exercised separately. |
| Execute Iteration 4, all viewports | The deterministic two-agent workflow exposed full target status/reasons, guided lifecycle state, read-only manifest, keyboard-scrollable portrait evidence, 44px targets, reduced motion, focus trap/restore, contained scrolling, and actual Execute CSS in both load orders. |
| Execute Iteration 2 historical, 1440×900 | Title `Rallar Black Box`, canonical Recipe Console marker/URL, meaningful DOM, 11 repository fixtures, required four featured fixtures, 2/2 targets, and exact sample group. No framework overlay or page error. Superseded by the Iteration 4 row above. |
| Execute → failed Monitor → Tune, Iteration 2 historical | URLs committed each view. The then-seeded Monitor exposed both exact synthetic codes, seeded recipe/command IDs, six status shapes, and the desktop inspector. Tune committed Send-duration then Command metrics and kept unavailable RTC evidence explicit. The Monitor portion is superseded by the Iteration 5 rows. |
| Blank and old-alias entries | Blank `provider=simulated` and `workspace=black-box-runner&tab=recipes` mounted only legacy, preserved the URL, and left Recipe Console unmounted. |
| Live Monitor portrait, 430×932 | The refreshed baseline keeps verdict → failures → matrix → timeline order and the exact Refresh, Cancel run, Load artifact, Export artifact action order. Representative targets are at least 44px; the sheet traps focus, Escape restores it, and document overflow is zero. |
| Live Monitor tablet, 900×900 | Work remains stable before and after the 360px overlay; the overlay does not squeeze the work plane, and Escape restores focus. |
| Live Monitor landscape, 932×430 | The keyboard-only failure-inspector and armed-Cancel paths restore focus. The matrix owns horizontal overflow while document overflow remains zero on both axes before and after the dialog path. |
| Reduced motion | Live Monitor overlay transition duration is `0s`, animation is removed, and state remains visible. |
| Tune landscape, 932×430 | Matrix/timing ratio was 0.520008; three agents/four rows, ArrowDown/Enter/close/focus restoration, and zero document overflow passed. |
| CSS isolation | Both load orders and Recipe Console → legacy → Recipe Console retain stable computed styles. Iteration 5 adds live Monitor comparisons for both load orders; the historical Iteration 2 system-Chrome load-order PNGs remain byte-for-byte identical (`cmp=0`, SHA-256 `39259c08719440dd98ef60898466d8a5a7b722e81b6b5e637de2481d7dc528a6`). |
| Console/document health | A focused RED exposed the missing icon. `index.html` now declares a local SVG icon; its response is HTTP 200 with `image/svg+xml`. A fresh canonical Execute run had `consoleDiagnostics: []` and `failedResponses: []`. |

The Iteration 2 fallback screenshots remain historical temporary QA artifacts under
`/tmp/rallar-task10-browser-qa-system-chrome/`, numbered `01` Execute desktop
through `11` reverse-order CSS isolation. The checked-in concept baselines
above, including the two refreshed Iteration 5 Monitor captures, are the durable
pixel evidence. The old offline runner alias made the expected
unavailable-service requests to `localhost:5180` and `api.example.invalid`;
they are not counted as live-service passes.

## Automated validation

| Command | Result | Evidence |
| --- | --- | --- |
| Iteration 5 exact nine-file focused Vitest set | Passed | 9/9 files, 229/229 tests after all review fixes. |
| Iteration 5 complete `packages/tests/rallar-black-box` set | Passed | 72/72 files, 708/708 tests. |
| Iteration 5 shared/app checks and production build | Passed | Shared-test and app TypeScript checks, a 507-module production build, and the reciprocal Recipe Console/Legacy Experience closure assertion passed. |
| Iteration 5 complete Recipe Console Playwright config | Qualified | 100 passed, one exact configured-live skip. Covers deterministic live Monitor truth, 1440 desktop, 900 tablet, 430×932 portrait, 932×430 landscape, keyboard-only evidence/Cancel paths, focus, 44px targets, reduced motion, zero overflow, operational/reconnect states, CSS isolation, and refreshed baselines. |
| Iteration 5 exact legacy navigation/ticket pair | Passed | 28/28 Chromium tests; old deep links and the selected-run legacy handoff remain operational. |
| Iteration 5 control-server check/tests | Passed | Control-server check and 57/57 Deno tests. |
| Iteration 5 configured full-stack wrapper | Skipped; not passed | Exited successfully with exactly one configured skip because the required Postgres-backed stack was unavailable; the exact reason is recorded below. |
| Iteration 6 focused artifact/Analyze Vitest set | Passed | 15/15 files, 226/226 tests after shared and app/state review fixes. |
| Iteration 6 complete `packages/tests/rallar-black-box` set | Passed | 81/81 files, 786/786 tests with required loopback/IPC permission. |
| Iteration 6 shared/app checks and production build | Passed | Shared-test and app TypeScript checks, reciprocal experience closure, and a 551-module build passed. Recipe Console CSS is 74.32 kB (12.10 gzip) and JS is 215.53 kB (58.63 gzip); the existing preserved large-chunk advisory remains. |
| Iteration 6 complete Recipe Console Playwright config | Qualified | 119 passed, one configured-live test skipped with the exact unavailable-service reason. Analyze covers every contract viewport, keyboard/focus, 44px targets, reduced motion, operational/adversarial states, overflow, and CSS load orders. |
| Iteration 6 Analyze browser owners | Passed | 19/19 across canonical, safety, visual, and handoff owners, including future schema, 25-file rejection, every required search field, late Control response context safety, keyboard-owned picker activation, actual drop, and activated legacy destinations; all owners are 90–267 lines. |
| Iteration 6 exact legacy navigation/ticket pair | Passed | 28/28 Chromium tests; old tabs, aliases, and session-ticket behavior remain operational. |
| Iteration 6 control-server contract regression | Passed | 57/57 Deno tests, including schema-v2 artifact export. |
| Iteration 4 focused Vitest set | Passed | 18/18 files, 294/294 tests after all review fixes. |
| Iteration 4 complete `packages/tests/rallar-black-box` set | Passed outside socket-restricted sandbox | 67/67 files, 656/656 tests. |
| Iteration 4 Recipe Console Playwright config | Qualified | 89 passed, one configured-live test skipped with the exact unavailable-service reason below. Includes Execute lifecycle, responsive/accessibility, operational-state, CSS-isolation, and refreshed fidelity proof. |
| Iteration 4 exact legacy navigation/ticket pair | Passed | 28/28 Chromium tests; old deep links and ticket-origin behavior remain operational. |
| Iteration 4 build/chunk/control-server exit | Passed | SPA and shared-test typechecks, 479-module build, reciprocal lazy-closure assertion, control-server check, and 57/57 Deno tests. Recipe Console JS is 110.48 kB minified; only the preserved LegacyExperience chunk triggers the existing 500 kB warning. |
| Focused Iteration 2 eleven-file Vitest set | Passed | 11/11 files, 81/81 tests, 487ms. Covers experience precedence, URL codec/history, seeds, shell structure, responsive presentation, keyboard navigation, build boundary, auth, and legacy composition/structure. |
| `npm --workspace rallar-black-box run typecheck` | Passed | `tsc --noEmit`, exit 0. |
| `npm --workspace rallar-black-box run build` | Passed with preserved advisory | 442 modules, 140ms. Only the lazy LegacyExperience JS exceeds 500 kB. |
| `npx tsx apps/rallar-black-box/scripts/assert-experience-chunks.ts` | Passed with Node advisory | Independently found the Recipe Console and legacy hashed JS/CSS closures; emitted Node `DEP0205`. |
| Iteration 2 Recipe Console Playwright config | Passed | 40/40 Chromium tests using seven workers, 23.5s. Includes four no-update pixel baselines plus semantic/geometry checks. |
| Exact legacy navigation/ticket Playwright pair | Passed | 28/28 Chromium tests using two workers, 1.3m. |
| Full `packages/tests/rallar-black-box` Vitest set | Passed | 58/58 files, 460/460 tests, 5.56s. |
| `@ar-eye-hunter/shared-test` TypeScript check | Passed | `tsc -p tsconfig.json --noEmit`, exit 0 after the selection-aware causal-trail helper was added. |
| `@ar-eye-hunter/shared-test` Deno check half | Unavailable; not passed | Existing Deno node_modules could not resolve `npm:@types/node`. The seven configured Deno entry points were enumerated, but the check terminated on dependency resolution before it could qualify them. |

During the historical Iteration 2 pass, both Playwright commands first failed
to bind sandboxed `127.0.0.1:5176`
with `EPERM`; exact escalated reruns passed. The first sandboxed broad Vitest
run likewise had 458/460 because tsx IPC and localhost listeners were denied;
the exact escalated rerun passed 460/460. These environmental failures are not
represented as product passes. Other non-failing output was the known
`NO_COLOR`/`FORCE_COLOR` message, Node experimental `localStorage` warning,
and the expected unsafe-artifact-filename skip diagnostic.

| Iteration 5 current production asset | Raw decimal kB | zlib gzip kB |
| --- | ---: | ---: |
| Recipe Console CSS | 57.18 | 9.80 |
| Recipe Console JS | 153.89 | 41.57 |
| LegacyExperience CSS | 109.85 | 17.23 |
| LegacyExperience JS | 766.67 | 178.53 |
| Entry CSS | 3.57 | 1.28 |
| Entry JS | 151.58 | 38.63 |
| Rallar shared JS | 476.65 | 111.28 |

These values are recomputed from the fresh 507-module build's emitted bytes
using decimal kilobytes and Node `zlib.gzipSync`, so they are reproducible from
the current `dist` artifacts rather than copied from terminal rounding. The
live Monitor increases the Recipe Console closure from its Iteration 2/4
baselines while remaining separate from the preserved legacy closure. Only the
lazy LegacyExperience JS retains the existing greater-than-500-kB advisory.

| Historical Iteration 2 production asset | Minified | Gzip |
| --- | ---: | ---: |
| Recipe Console CSS | 25.37 kB | 5.24 kB |
| Recipe Console JS | 47.31 kB | 14.32 kB |
| LegacyExperience CSS | 109.84 kB | 17.18 kB |
| LegacyExperience JS | 780.37 kB | 183.09 kB |
| Entry JS | 145.10 kB | 36.81 kB |
| Rallar shared JS | 476.64 kB | 112.13 kB |

The current production build's explicit Recipe Console closure remains
separate from the preserved legacy closure. Historical Iteration 2 figures are
retained above for comparison, not represented as current asset sizes.

## Live-service qualification

Live/Postgres validation is skipped, not passed, unless the complete stack is
explicitly enabled. Current exact skip reason:

`Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1, apps/rallar-black-box-control-server, and apps/rallar-black-box available.`

The Iteration 5 configured acceptance requires exhaustive Postgres mode,
authenticated `browser-rallar` agents, a visible passed Execute → Monitor
artifact export, and a distinct visible non-terminal Monitor cancellation with
one cancel link per target plus dispatched/completed successful
`recipe.cancel` commands. The current environment did not provide that stack,
so the wrapper produced exactly one skip under the gate above. Deterministic
live-control Monitor proof is qualified, but configured live Postgres proof is
not: Ready-State #3 remains open.

## Remaining risks and deferrals

- The pixel baselines are controlled-Darwin evidence. Other platforms execute
  the semantic and geometry assertions but require their own approved pixels
  before claiming cross-platform exactness.
- Local Node 26.5.0 differs from CI Node 24; CI remains the version-compatibility
  authority.
- The preserved lazy LegacyExperience chunk remains larger than 500 kB. The
  new Recipe Console closure does not absorb it; legacy decomposition remains
  later strangler work.
- Iteration 5 implements live control polling and deterministic live Monitor
  truth, but the configured Postgres lifecycle remains skipped. Ready-State #3
  therefore remains open; artifact import, comparison, tuning, fleet,
  diagnostics cutovers, and the remaining acceptance evidence belong to
  Iterations 6–12.
- Every migration-register row remains uncut and every old deep link remains a
  rollback path. No primary legacy surface is hidden, and the default experience
  is unchanged.

## Iteration 2 review verdict

The first whole-iteration review was not approved and reported five Important
findings: history-restored Execute inspection, unconditional portrait dock,
selected-fixture/preflight truth, inert Refresh/Export, and stale copy that
implied live connectivity. It also reported the native-button selection-state
minor. Browser QA separately found the missing document icon.

Each behavior received focused RED evidence before its fix. The final behavior
set restores Execute inspection through history, renders a dock only for a real
selection/action, removes default target claims for unmatched fixtures,
disables their Stage/Start actions, resets all seeded workspace state on
Refresh, exports deterministic `preview: true`/`live: false` JSON, uses
preview-truth stale copy, exposes native `aria-pressed` state with its visible
selection rail, and serves the SVG icon successfully.

The subsequent exit audit found one additional Important selection-correlation
leak: the recipe rollup inherited a runtime diagnostic correlated only to the
command failure. A focused RED reproduced it; shared deterministic
`correlatedFailureKeys` filtering now leaves the rollup with run-level artifact
evidence and explicitly denies direct diagnostic correlation, while command
selection retains all five canonical items. The final independent re-review
therefore reports **no Critical or Important finding**. Its focused browser
recheck passed the consolidated review regressions; the unmatched-target and
correlation RED/GREEN checks plus fresh structure/seed proof were approved.
One minor lifecycle risk remains: after leaving an unmatched
Execute fixture and returning through history, the command context can
theoretically show the unavailable label for one render until the remounted
Execute effect reports the default fixture. No incorrect action is enabled;
the durable-state assertions pass. This is retained as minor follow-up rather
than misrepresented as closed evidence.

## Iteration 4 Execute review verdict

Independent code/contract and browser/cutover passes found one Critical and
twelve Important issues in total, including credential-origin leakage risks,
stale post-await mutations, target drift, refresh ordering, URL diagnostics,
run identity reuse, operation-state cleanup, and Cancel focus policy. Each was
first reproduced by a focused failing assertion or mutation probe, fixed, and
included in the fresh 294/294 focused and 89-passed/one-skipped browser exit.
No Critical or Important Iteration 4 finding remains open. Both legacy workflow
rows stay visible and uncut because their complete cutover proofs are not yet
satisfied.

## Iteration 5 live Monitor review verdict

Independent code/contract, browser, and cutover review found seven Important
issues: two configured full-stack false-proof paths, selected-run legacy
handoff, portrait visual/DOM focus order, authoritative reconnect truth,
short-landscape overflow, and keyboard-only initiation evidence. Each received
focused RED/GREEN proof.
The fresh complete browser rerun passes 100 with the one exact configured-live
skip, and final re-reviews report no remaining Critical or Important finding.

This qualifies the code-backed live Monitor fidelity baseline, not the skipped
Postgres acceptance or a strangler cutover. Legacy Runs and Distributed Recipes
remain visible and deep-linkable; no navigation hide or default flip occurred.

## Iteration 6 Analyze review verdict

Independent shared-contract review closed three Important findings around
index retention, precise JSONL provenance, and loose-file identity consistency.
Independent app/state review closed six Important findings covering retained
context truth, paired control/distributed authority, unsafe and malformed-
Unicode identities, bounded filenames, and accurate malformed/concurrent
operation announcements. Every item received focused RED/GREEN proof; final
re-reviews report no Critical or Important finding.

This qualifies Ready-State #6 and the bounded distributed-run Analyze
capability. It does not qualify the skipped Postgres lifecycle, generic
black-box-runner import, history/comparison, a navigation hide, or a default
flip. Legacy Runs and Shared Test remain visible and deep-linkable.
