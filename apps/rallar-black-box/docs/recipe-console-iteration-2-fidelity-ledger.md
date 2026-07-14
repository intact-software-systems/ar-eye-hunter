# Recipe Console Iteration 2 Fidelity Ledger

Status: Direction A is preserved through the qualified Iteration 12 default
cutover; Recipe Console Execute, Monitor, Analyze, Tune, Fleet, and Advanced,
the final accessibility matrix, and Ready-State #1–#14 are code-backed through
`4f04228` and `aec6e57`

Evidence date: 2026-07-14
Implementation heads: `a397642` (Iteration 2), `8d44a99`, `bddde71`
(Iteration 4 Execute), `42eedae` (Iteration 5 live Monitor fidelity proof),
`f96b5b4`, `abe257e`, `9b07330`, `47c332d` (Iteration 6 Analyze),
`cc17169`, `382df72` (Iteration 7 Tune), `fd9055e`, `f762749`
(Iteration 8 History/retention), `8c630fc` (Iteration 9 Task 6 Monitor scale),
`796fa59`, `66a16fd`, `12999dd`, `f8cef95` (Iteration 9 scale/fidelity exit)
and `0088be0`, `3ab86a9` (Iteration 10 Fleet), plus `75ab910`, `84493f3`,
`2502f50`, `78e2c13` (Iteration 11 Advanced diagnostics)
and `4f04228`, `aec6e57` (Iteration 12 final cutover)
Approved direction: Signal Ledger (Direction A)

This ledger preserves the approved Iteration 2 visual contract and its
historical seeded Monitor/Tune evidence, then records the Iteration 4 Execute,
Iteration 5 live Monitor, Iteration 6 Analyze, Iteration 7 Tune, and Iteration 8
History/retention baseline advances, then records the Iteration 9 bounded
Analyze/Monitor/History/Execute/Tune extension, the Iteration 10 bounded
Fleet/geographic evidence workspace, the Iteration 11 contextual Advanced
bridge, and the Iteration 12 final responsive/accessibility/default cutover.
The configured live/Postgres owner now passes separately; no legacy row is
retired.

## Iteration 12 final fidelity addendum

Direction A remains unchanged. The blank/provider-only entry now opens
canonical Recipe Console Execute, while explicit legacy URLs and every
Advanced/contextual destination retain the existing visual and operational
owner. The settled deterministic Recipe Console configuration passes 196
tests with one exact opt-in live wrapper skip. The separately configured
Postgres/API/control/SPA suite executes 4/4, so the skip is retained as a skip
and is not used to claim live fidelity.

Final controlled QA passes desktop 1440x900, tablet 900x900, genuine-touch
portrait 430x932, genuine-touch short landscape 932x430, keyboard, reduced
motion, 44px targets, modal trap/restore and detached-trigger fallbacks,
persistent non-hover evidence, complete operational states, and both CSS load
orders. The final regular matrix passes 48/48. Production chunk/Advanced proof
passes 13/13 and all eight concept baselines pass under the deterministic
Recipe Console config without snapshot updates. The regular config is not the
concept/production-preview owner: it forces SwiftShader and starts 5176/5180,
not the required preview 4176. Its rejected 5-pass/8-connection-refused attempt
is recorded as plan/config drift, not visual or product failure.

The final Ready-State captures were inspected at original resolution. Their
SHA-256 values are:

| Capture | SHA-256 |
| --- | --- |
| Ready-State desktop 1440x900 | `e6f0d087e2a63aafbf425049411a99e19fa4879dbef2a84643f0a305f0060627` |
| Ready-State touch portrait 430x932 | `87bc16445d2ab57e8ec71decf4c3cdd885d1cf7da958d433b980000d3f551a7c` |
| Ready-State touch landscape 932x430 | `bf37d2027e7724e08957c8175cc8cb78a4a9625506582444a4bea7d17e94a7ea` |
| Legacy CRDT touch portrait 430x932 | `85a7c0815cdc747bd8e6cd3ebca0ce3c12885406951dd43e7e5be9a3601749f9` |
| Legacy CRDT touch landscape 932x430 | `142504ea874618a0adbbcea8ad4dfeaaded234c9b1ed6d29fdc3bae9c87400ce` |

No unexplained clipping, overlap, page overflow, hidden control, hover-only
evidence, or color-only state remained. Compact header labels truncate
intentionally; portrait uses the bottom navigation and landscape the rail.
The explicit six-view console/page-error acceptance observed no relevant
warning, error, or page error. The in-app Browser remains unavailable exactly
as `Browser runtime unavailable after setup failure: Cannot redefine property:
process`; terminal Playwright is fallback evidence, not an in-app Browser pass.

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

## Iteration 7 real-evidence Tune fidelity addendum

Direction A remains unchanged. Tune now opens as a separate lazy, inactive-
unmounted entry and reads the one retained Analyze artifact plus the root
control query. The seed is gone. The short-landscape Signal Ledger preserves
the compact rail, flat ruled regions, decision/evidence-first order, contained
work scrolling, and contextual inspection while replacing the concept's
invented matrix with repository-authoritative command and RTC stream planes.

The durable real fixture shows source status and provenance; 30 planned, 28
scheduled, 23 attempted, 22 completed, one failed, five dropped, two in-flight
drops, six late frames, four backpressure events, 30/28/22 Hz requested/
scheduled/achieved cadence, 28 ms max drift, and 23/68/92/92 ms P50/P95/P99/
max send duration. Command timing is 400/400/1,200/1,200/1,200 ms min/P50/P95/
P99/max, with an 800 ms mean, 3× spread, one outlier, and specific slow agent
`tune-agent-slow`. Fourteen editable recipe knobs, visibly blocked/shadowed
rows, readiness-first hints, explicit two-run deltas, candidate JSON Patch/
diff, source immutability, and no mutation requests replace seed-era claims.

Controlled QA covers 1440×900, 900×900, 430×932, and 932×430; keyboard-only
source/comparison/metric/agent/knob/candidate/copy/inspector/handoff paths;
focus trap/restore; 44px targets; reduced motion; atomic announcements; zero
document overflow; and actual Tune CSS in both legacy load orders. The complete
Recipe Console configuration passes 137 available tests with one exact
configured-live skip. The focused matrix passes 58/58 and Tune passes 12/12.
The refreshed 932×430 baseline was inspected at original detail after semantic
and geometry gates passed. The in-app Browser remained unavailable exactly as
`No browser is available`; this is Playwright/System Chromium fallback proof.

## Iteration 9 Task 6 large-Monitor fidelity addendum

Direction A remains unchanged. The Signal Ledger keeps failure verdict and
failure list first, followed by the agent/recipe/readiness evidence plane and
secondary timeline/event/composite/diagnostic disclosures. Task 6 replaces
fixed prefixes with local Previous/Next controls and exact range/outside-
window truth; it does not add a global registry, broad stylesheet, alternate
visual direction, or hidden mounted evidence. Closed disclosures mount no
retained rows, while reopening restores their local cursor.

The settled large fixture verifies exact stable-ID traversal across every main
and inspector pressure path without gaps or duplicates, bounded main and
inspector mounts, filter-owned resets, polling/threshold focus recovery,
URL-stable reverse traversal, exact long bidi identifiers, current/last-known
operational truth, and unchanged failure correlations/actions. The command bar
uses locally contained ellipsis at 932×430 so Connected, Safe targets, and
Active run cells do not overlap; operational metric values remain legible.

Controlled Playwright/System Chromium proof passed 17/17 affected cases:
11/11 combined new/existing Monitor flows plus 6/6 Monitor responsive,
accessibility, and CSS-isolation slices. The new large fixture passed 4/4 at
1440×900 desktop, genuine-touch 430×932 portrait, and genuine-touch
932×430 landscape, with keyboard focus, touch taps, 44px targets, reduced
motion, contained internal scrolling, zero document overflow, and stable
Direction A hierarchy. The desktop, portrait, and landscape screenshots were
visually inspected and clean. The in-app Browser was unavailable exactly as
`No browser is available`; this is Playwright/System Chromium fallback proof,
not an in-app Browser pass.

Two early browser attempts overlapped live consumer composition or a neutral
binding-file move and were unavailable as product verdicts; both affected sets
reran fully green on stable source. A direct `tsx --test` UI attempt was
unavailable because Node cannot load CSS modules; authoritative Vitest passed.
The configured-live lifecycle remains skipped, not passed, for exactly: `Set
RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
apps/rallar-black-box-control-server, and apps/rallar-black-box available.`
Ready-State #10 and parent Iteration 9 remain open for Tasks 7–9, canonical
scale acceptance, remaining heartbeat proof, and final profiling. No default
or primary navigation, legacy visibility/mount, deep link, rollback URL, or
cutover changed, and no legacy row was hidden.

## Iteration 9 scale-selector fidelity addendum

Direction A remains unchanged. Execute's required searchable, windowed control-
run picker now uses an explicit inline layout variant, restoring the approved
label/control row and leaving the checked-in Execute baseline unchanged. The
complete Control browser contract passes 20/20 against the disclosure trigger,
editable search combobox, bounded listbox options, unavailable-selection truth,
keyboard commit, history, copy, reload, and touch-size behavior; no stale native
`select` assertion remains.

Tune retains the approved 932×430 source geometry and concise `Select baseline`
and `Select candidate` copy. Missing-selection messages remain in the comparison
truth without duplicating visible error rows beside the placeholders; invalid and
same-run errors remain adjacent and explicit. Its baseline refresh is intentional:
the native `select` chrome was replaced by the required searchable disclosure,
combobox, and windowed listbox that bounds 5,000 run options to at most 100 mounted
rows. After semantic and geometry gates passed, the stable pre-refresh difference
was 3,398 pixels; exact native-control pixels cannot represent the new interaction
contract. The refreshed baseline SHA-256 is
`e0dfaf3e29e9a9d5de054aea7aac637af4f446ff966756cbfdbd5b8657bdca94`.

Monitor preserves the repository-tested operational action order (`Refresh`,
`Cancel run`, `Load artifact`, `Export artifact`) and exact bidi-isolated machine
identifiers introduced by bounded evidence windows. The failure-destination row
no longer repeats an exact identifier on a third visual line; the identifier is
isolated inside its existing label. Those later safety/interaction contracts must
not be undone to imitate the older Iteration 5 pixels. After semantic and geometry
gates passed, the stable pre-refresh difference was 21,694 pixels. The refreshed
failed-desktop baseline SHA-256 is
`f5cfc68090cb1171e6e464d098cf7f0ddeb2b0250a9cf062fde13c61af372c38`.
The Execute and portrait Monitor baselines were not refreshed. A final no-update
Darwin run passes all four Direction A captures; focused structure/behavior passes
89/89 and app TypeScript passes.

The final Iteration 9 exit additionally passes all 169 available Recipe Console
browser cases, including desktop, tablet, touch portrait/landscape, keyboard,
reduced motion, operational states, both CSS load orders, chunks, and unmount
cleanup. Independent re-review caught and RED/GREEN fixed detached inspector
focus after live window shrink: focus now tries the connected trigger, exact
owning range anchor, visible selection dock, then named work surface, verifying
success before stopping. The configured-live owner is the sole skip and is not
represented as visual or runtime pass. No legacy row, default, or cutover changed.

## Iteration 10 Fleet fidelity addendum

Direction A remains unchanged. The Fleet workspace follows the Signal Ledger
order: operational/source truth, live and historical summary, repeated failure
and timing evidence, then a secondary deterministic map and exact report/
artifact detail. The map is never the only carrier of a conclusion or action;
equivalent persistent HTML controls expose provenance, unresolved locations,
candidate/rendered/omitted counts, and complete bounded traversal. Current live
status and historical outcomes remain visually and semantically separate.

Controlled terminal Playwright/System Chromium QA covers 1440×900 desktop,
900×900 tablet, genuine-touch 430×932 portrait, and genuine-touch 932×430
landscape; keyboard-only traversal and focus recovery; 44px touch targets;
reduced motion; long/bidi identifiers; loading, live, partial, stale, offline,
empty, and schema-error truth; URL copy/reload/back-forward; exact evidence
handoffs; selected-report load/export; bounded map/window budgets; zero document
overflow; both CSS load orders; inactive unmount/cleanup; and reciprocal chunk
separation. The canonical Fleet owner passes 7/7, its three-case visual owner
passes no-update 3/3, the broader Recipe Console regression matrix passes 65/65,
and the complete Recipe Console configuration passes 179 with one exact
configured-live skip. Legacy Fleet/navigation passes 33/33 and existing-owner
regressions pass 28/28.

Five approved Darwin baselines were inspected at original detail after semantic,
geometry, overflow, map-budget, and interaction gates passed:

- desktop:
  `direction-a-fleet-desktop-chromium-darwin.png`, SHA-256
  `f621428cedfdd6260826d6aacf58962a8742694ddc95bee5fa61c37c6257bcac`
- tablet:
  `direction-a-fleet-tablet-chromium-darwin.png`, SHA-256
  `ead980c88f19f61dbd406342c678904590b248c83a8dad54123793a71acc39cf`
- stale desktop:
  `direction-a-fleet-stale-desktop-chromium-darwin.png`, SHA-256
  `0d26b4b63e7814e0e3c89f593ee05463735de85f0390fecbbea08b72e123ff5f`
- touch portrait:
  `direction-a-fleet-touch-portrait-chromium-darwin.png`, SHA-256
  `12a76900434ec94a611a9304784ad4a4fc495f334cd9d768a1fd27402e8c6bb4`
- touch landscape:
  `direction-a-fleet-touch-landscape-chromium-darwin.png`, SHA-256
  `dd2b2fbe63a636941e212e7a07b25a520383f8886da2ca02c6479aca060589d8`

The baselines live under
`../../../tests/playwright/rallar-black-box/recipe-console-fleet-visual.spec.ts-snapshots/`.
They establish no second visual direction and do not authorize a legacy hide.
The in-app Browser was attempted first and was unavailable exactly as `Browser
runtime unavailable after setup failure: Cannot redefine property: process`;
terminal Playwright is the fallback, not an in-app Browser pass. Configured
live/Postgres remains skipped, not passed, for exactly: `Set
RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
apps/rallar-black-box-control-server, and apps/rallar-black-box available.` The
standalone configured-live owner independently reports one skip for that same
reason.

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
| Tune short landscape | `docs/recipe-console-concepts/iteration-2-signal-ledger-tune-landscape.png` (1847×851) | `../../../tests/playwright/rallar-black-box/recipe-console-concept-fidelity.spec.ts-snapshots/signal-ledger-tune-landscape-chromium-darwin.png` (932×430, Iteration 7 refresh) | Compact rail, flat ruled source/decision/evidence regions, command/stream two-plane evidence, and contained scrolling retained. Real artifact/control truth, explicit uncommitted comparison placeholders, and sourced timing replace the illustrative seed matrix. |

## Fidelity decision ledger

| Dimension | Evidence and decision |
| --- | --- |
| Copy and data truth | **Intentional, explained deviation.** Execute selects the real `RTC Realtime Stability` fixture and deterministic mocked-live two-agent state recorded in the Iteration 4 addendum. Monitor uses deterministic live control/distributed-run truth from Iteration 5; Analyze uses artifact truth from Iteration 6; Tune uses the retained real artifact and bounded root-control snapshot from Iteration 7. None repeats the concepts' illustrative ACK recipe, 8/8 target set, or seeded tuning values. |
| Historical Iteration 2 Monitor truth | The original canonical `failed-command` seed rendered distributed run `seed-failed-command`, control run `seed-control-failed-command`, recipe `seed-rtc-recipe`, and one of two agents failed. The two rows were `SYNTHETIC_RECIPE_FAILED` and `SYNTHETIC_ASSERTION_FAILED`; both said `Receiver did not observe the RTC payload.` The command-correlated row used `seed-agent-b` and `seed-start-receiver`. This remains concept-history evidence, not the current Monitor source. |
| Iteration 5 live Monitor truth | The deterministic fixture renders control run `monitor-control-live`, distributed run `monitor-distributed-live`, recipe `monitor-later-failure`, sender/receiver agent evidence, and failure `MONITOR_EXPECTED_PAYLOAD_MISSING` on `monitor-start-receiver`. The fixture changes authoritative snapshots to prove disconnect → reconnect, complete/partial/last-known/offline recovery, operational run transitions, bounded events, cancellation, artifact operations, deletion, and late-response rejection. |
| Tune truth | Real artifact/control evidence replaces `high-latency-rtc`. The RTC stream has 30 planned, 28 scheduled, 23 attempted, 22 completed, one failed, five dropped, two in-flight drops, six late frames, four backpressure events, 30/28/22 Hz requested/scheduled/achieved cadence, 28 ms max drift, and 23/68/92/92 ms P50/P95/P99/max duration. Command min/P50/P95/P99/max are 400/400/1,200/1,200/1,200 ms, with an 800 ms mean, 3× spread, one outlier, and slow agent `tune-agent-slow`. Missing/partial/reference-only evidence remains visibly unavailable rather than invented. |
| Layout and hierarchy | Edge-to-edge shell, persistent command band, exact six-destination order, continuous ruled work planes, one contextual inspector, and failure-before-raw-evidence ordering match the approved direction. There is no centered dashboard or card wall. |
| Typography | System/Inter-compatible sans typography, 18px route/section hierarchy, compact 12–14px evidence text, and monospace/tabular machine IDs and durations reproduce the concept's dense operational register. Sentence case is retained; machine codes alone use uppercase. |
| Palette and statuses | Scoped cool canvas, white surfaces, cobalt selection/action, and distinct passed/failed/warning/stale/partial/disabled roles use the approved tokens. Every operational state includes a label and shape/icon; no verdict depends on color alone. Hard stale evidence remains visible. |
| Icons | One code-native outline SVG family is used. Navigation retains text; icon-only refresh/copy controls have accessible names and tooltips. There is no emoji or rasterized UI text. |
| Control geometry | Desktop controls remain compact; every representative portrait command, route, recipe, inspector, segmented, and Advanced compatibility target is at least 44×44px. Bottom-navigation targets have 8px separation. The optional URL feedback occupies its own 44px context row and cannot cover work content. |
| Responsive transformation | 1440×900 desktop uses a 184px rail and 352/360px inspector. At 900×900 the 64px rail remains and the 360px inspector overlays without squeezing work. The 430×932 portrait uses one work scroller, the selection dock, bottom navigation, one modal-sheet inspector, and contained horizontal evidence scrolling. The 932×430 Tune refresh uses a 48px command bar, 60px rail, compact source/decision/evidence regions, bounded pane scrolling, and zero document overflow on both axes. |
| Keyboard and focus | Primary navigation has one roving tab stop; arrows/Home/End move focus and Enter/Space activate. Tune's source, comparison, metric, slow-agent, knob, candidate, copy, inspector, and legacy-handoff paths are keyboard-operable; the live comparison announcement is atomic. Live Monitor opens failure evidence and initiates armed Cancel without a pointer. Overlay/sheet focus is trapped, Escape closes, and focus returns to the invoking control. |
| Motion | Interaction transitions stay bounded; reduced-motion emulation resolves inspector transition duration to `0s` and removes travel/repeated emphasis without hiding state. |
| CSS isolation | Tokens/reset are scoped under `.recipe-console`; feature styles are CSS Modules. The reverse-load-order fixture proves representative Recipe Console and legacy controls, tables, forms, statuses, dialog geometry, live Monitor, and real Tune styling are stable cold, legacy-first, and after a legacy round trip. No broad legacy selector is required by the new shell. |
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

The in-app Browser was attempted first for the latest Task 6 pass. It was
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
| Large Monitor Task 6, desktop and true-touch portrait/landscape | Main and inspector windows traverse every stable identity without gaps/duplicates, preserve exact omission and operational truth, recover focus, keep Previous navigation URL-stable, expose 44px tap targets, disable new-control motion, and contain long bidi evidence and the short-landscape command bar without overlap or document overflow. |
| Fleet Iteration 10, desktop/tablet/true-touch portrait/landscape | The operational summary, complete bounded evidence windows, secondary provenance-bearing map, exact handoffs, artifact load/export, URL history, keyboard/focus, 44px targets, reduced motion, long/bidi IDs, and every degraded state remain contained with zero document overflow. Five reviewed Direction A baselines pass no-update. |
| Tune landscape, 932×430 | The Iteration 7 refresh shows retained-artifact provenance, uncommitted baseline/candidate placeholders, decision-first hints, and command/stream evidence in bounded panes. Keyboard inspection/focus restoration, 44px actions, contained scrolling, and zero document overflow pass. |
| CSS isolation | Both load orders and Recipe Console → legacy → Recipe Console retain stable computed styles. Iteration 7 adds real Tune source, comparison, candidate, and inspector comparisons; the historical Iteration 2 system-Chrome load-order PNGs remain byte-for-byte identical (`cmp=0`, SHA-256 `39259c08719440dd98ef60898466d8a5a7b722e81b6b5e637de2481d7dc528a6`). |
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
| Iteration 10 focused Fleet contract | Passed | 18 files and 279/279 tests covering tolerant validation, shared indexed report/geography truth, legacy parity, bounded transfer, workspace state/handoffs, UI/structure, URL state, shell composition, aliases, and experience routing. |
| Iteration 10 complete app/shared/build gate | Passed with preserved advisory | 139 files and 1,472/1,472 app tests; shared/app TypeScript; shared configured Deno plus direct checks of all three Fleet modules; `git diff --check`; a 758-module build; and reciprocal experience closure. Fleet emits 62.26 kB JS (15.98 kB gzip) and 22.76 kB CSS (3.90 kB gzip). Only the pre-existing greater-than-500-kB `LegacyExperience` advisory remains. |
| Iteration 10 Fleet browser and visual owners | Passed | Fleet 7/7 and visual no-update 3/3 across desktop, tablet, genuine-touch portrait/landscape, keyboard/focus, 44px targets, reduced motion, operational states, URL history, exact handoffs, artifact load/export, bounded map/windows, overflow, CSS load order, inactive cleanup, chunks, and aliases. Five SHA-256 baselines are recorded above. |
| Iteration 10 complete Recipe Console configuration | Qualified | 179 passed and one exact configured-live skip (180 total). The broader focused Recipe Console regression matrix passed 65/65; legacy Fleet/navigation passed 33/33; existing-owner regressions passed 28/28. The standalone configured-live owner independently reported one skip. |
| Iteration 10 in-app Browser attempt | Unavailable; not passed | Exact failure: `Browser runtime unavailable after setup failure: Cannot redefine property: process`. Terminal Playwright/System Chromium is fallback evidence. |
| Iteration 10 configured live/Postgres owner | Skipped; not passed | Exact reason: `Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1, apps/rallar-black-box-control-server, and apps/rallar-black-box available.` |
| Iteration 9 Task 6 composed Vitest gate | Passed | 11 files and 226/226 tests: 28 query, 24 structure, 10 shared topology, 3 cache, 69 API, 27 Monitor state, 17 board, 26 control selection, 1 provider, 13 main-window, and 8 inspector-window. |
| Iteration 9 Task 6 app/build/chunk gate | Passed | App TypeScript, `git diff --check`, a 655-module production build, and reciprocal `RecipeConsoleApp-D4wdYE2J.js` / `LegacyExperience-DzD-0gim.js` closure proof passed. Only the preserved greater-than-500-kB advisory remained. |
| Iteration 9 Task 6 stable-source Chromium gate | Passed | 11/11 combined new/existing Monitor cases plus 6/6 responsive/accessibility and CSS-isolation Monitor cases. The large fixture itself passed 4/4 across desktop and genuine-touch portrait/landscape, keyboard/focus, reduced motion, operational states, exact traversal, URL stability, bounded mounts, and Direction A containment. |
| Iteration 9 Task 6 unavailable attempts | Unavailable; not product failures or passes | One existing-Monitor attempt overlapped live consumer edits and one six-slice attempt overlapped the neutral binding-file move; both reran fully green on stable source. Direct `tsx --test` UI execution could not load CSS modules; authoritative Vitest passed. |
| Iteration 7 focused Vitest set | Passed | 20/20 files, 247/247 tests after shared, app/state, and browser review fixes. |
| Iteration 7 complete `packages/tests/rallar-black-box` set | Qualified green | 93 files and 883 tests. The restricted sandbox passed 881; its only two failures were denied tsx IPC/loopback. The exact affected `headless-worker-script.test.ts` file then passed 9/9 with required permission. |
| Iteration 7 complete shared/app/build exit | Passed | Shared-test TypeScript and all seven configured Deno entries, app TypeScript, `git diff --check`, a 580-module production build, and reciprocal experience-chunk proof passed. Tune emits separate 34.19 kB JS / 13.70 kB CSS lazy assets. |
| Iteration 7 complete Recipe Console Playwright config | Qualified | 137 passed and one configured-live owner skipped. The exact Tune suite passed 12/12, the focused browser matrix 58/58, and the chunk suite 7/7 across desktop, tablet, portrait, landscape, keyboard, reduced motion, operational/adversarial states, overflow, and CSS isolation. |
| Iteration 7 exact legacy navigation/ticket pair | Passed | 28/28 Chromium tests; old tabs, aliases, and exact legacy handoffs remain operational. |
| Iteration 7 control-server check/tests | Passed | Control-server check and 57/57 Deno tests; public contracts remain compatible. |
| Iteration 7 configured full-stack owner | Skipped; not passed | The configured-live owner was discovered in the complete Recipe Console configuration and skipped for the exact reason below. The forced live-stack script was not run because the required services were unavailable. |
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

| Iteration 7 production asset | Raw decimal kB | zlib gzip kB |
| --- | ---: | ---: |
| Tune lazy CSS | 13.70 | 2.59 |
| Tune lazy JS | 34.19 | 9.57 |
| Recipe Console CSS | 66.38 | 10.76 |
| Recipe Console JS | 205.52 | 55.51 |
| LegacyExperience CSS | 109.84 | 17.18 |
| LegacyExperience JS | 752.56 | 176.42 |

The Tune entry is absent when Tune never opens and its UI unmounts when
inactive. Only the preserved LegacyExperience JS retains the existing
greater-than-500-kB advisory; Recipe Console does not absorb that closure.

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

## Historical Iteration 8 live-service qualification (superseded by Iteration 12)

The status in this section records the Iteration 8 exit only. The Iteration 12
final fidelity addendum above supersedes it: the separately configured live
Postgres suite now passes 4/4 and Ready-State #3 is closed.

Live/Postgres validation is skipped, not passed, unless the complete stack is
explicitly enabled. Current exact skip reason:

`Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1, apps/rallar-black-box-control-server, and apps/rallar-black-box available.`

The Iteration 5 configured acceptance requires exhaustive Postgres mode,
authenticated `browser-rallar` agents, a visible passed Execute → Monitor
artifact export, and a distinct visible non-terminal Monitor cancellation with
one cancel link per target plus dispatched/completed successful
`recipe.cancel` commands. The current environment did not provide that stack,
so the configured-live owner discovered by the complete Recipe Console run
produced exactly one skip under the gate above. The forced live-stack script
was not run without its required services. Deterministic live-control evidence
is qualified, but configured live Postgres proof is not: Ready-State #3 remains
open.

## Historical Iteration 8 risks and deferrals (superseded by Iteration 12)

The bullets below are retained as dated migration evidence. Statements that
the configured lifecycle, final surfaces, accessibility work, or default flip
remain open describe the Iteration 8 checkpoint, not the final product state.

- The pixel baselines are controlled-Darwin evidence. Other platforms execute
  the semantic and geometry assertions but require their own approved pixels
  before claiming cross-platform exactness.
- Local Node 26.5.0 differs from CI Node 24; CI remains the version-compatibility
  authority.
- The preserved lazy LegacyExperience chunk remains larger than 500 kB. The
  new Recipe Console closure does not absorb it; legacy decomposition remains
  later strangler work.
- Iterations 6–8 implement distributed artifact analysis, bounded real-
  evidence tuning/comparison, History, saved filters, and guarded retention,
  but the configured Postgres lifecycle remains skipped. Ready-State #3
  therefore remains open. Large-run scale, Fleet, diagnostics cutovers,
  default flip, and final accessibility evidence belong to Iterations 9–12.
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

## Iteration 7 Tune review verdict

Independent shared-contract review found and closed safety gaps around
terminal-versus-progress RTC provenance, disconnect/barrier semantics, empty
performance, candidate validation, and owner size. Independent app/state
review closed malformed-recipe and source-authority drift, hidden blocked
knobs, stale inspection, explicit comparison selection, quarantine semantics,
and collision-free identity keys. Browser/cutover review closed compact-target,
live-announcement, operational/desktop-matrix, and evidence-assertion gaps.
Every Critical or Important finding received focused RED/GREEN proof; final
re-reviews report no remaining Critical or Important issue.

This qualifies Ready-State #7 and the bounded comparison plane for #8. It does
not qualify Ready-State #9, the skipped configured-live lifecycle, server
history, saved filters, retention, a legacy row cutover, or the default flip.
Legacy Runs, Compare, Distributed Recipes, and Run Manager remain visible,
deep-linkable, and governed by their unchanged mount policies.

## Iteration 8 History and retention review verdict

Independent server/client/state, UI/accessibility, and traceability reviews
closed Important findings around exact identity rendering, long-list keyboard
scrolling inside the modal trap, genuine keyboard-only filters, disabled-
control CSS authority, post-confirm token checks, all-eight-filter
copy/back-forward discrimination, and actual-deletion result scoping. Every
behavioral item received RED/GREEN evidence; final re-reviews report no
remaining Critical or Important issue.

The full Recipe Console configuration then exposed one stale 932×430 Tune
snapshot: History's required internal scroller reserved about four pixels.
Native-size comparison found unchanged hierarchy, content, alignment,
readability, wrapping, and containment. Only that approved Direction A
baseline was refreshed in `f762749`; the exact screenshot and fresh complete
browser configuration pass, and independent visual re-review is clean.

The qualified fidelity exit is 147 passed Recipe Console cases with one exact
configured-live skip, 55/55 focused History/Tune/chunk/responsive/CSS cases,
28/28 legacy navigation/ticket cases, and in-app Browser inspection at desktop,
portrait, and landscape with no warning/error logs. This qualifies Ready-State
#8 and #9 plus the bounded History/retention plane. It does not qualify
configured-live #3, a legacy row cutover, large-run scale, the default flip, or
Iterations 9–12. Every legacy fallback remains visible and deep-linkable.

## Iteration 9 Task 6 Monitor scale review verdict

Independent indexed-consumer review confirmed exact-revision trust binding,
constant-time trusted absence, active-only projection, selected-overlay legacy
parity, bounded owner structure, and randomized 5,000-pair behavior. Browser
review drove stable expected-ID traversal for every main and inspector window,
inspector outside-window truth, genuine touch/tap contexts, reduced-motion
coverage for the new controls, and URL-stable Previous navigation. Final exit
review then closed three Important findings with focused RED/GREEN coverage;
the indexed-consumer, browser, and exit re-reviews report no remaining Critical
or Important issue.

This qualifies only the Task 6 Monitor/index/window slice. Ready-State #10 and
parent Iteration 9 remain open for Tasks 7–9, canonical History/retention/
Execute/Tune pressure-list scale, the exact scale owner, remaining heartbeat
proof, and final profiling. Direction A remains the sole approved visual
baseline. No existing legacy row is hidden: all legacy surfaces retain their
visibility, active mount policy, old deep links, rollback URLs, and operational
fallback role, and no default/navigation/cutover changed.

## Iteration 10 Fleet review verdict

Independent shared-validation/analysis and geography reviews closed
surrogate-safe identity, literal-sentinel collision, live-projection freshness,
one-pass historical geography, and precomputed per-agent detail issues with
focused RED/GREEN proof. Independent React/state/accessibility and browser
reviews closed nested window focus ownership and tablet timing-grid containment.
Final shared, geography, UI, browser, and strangler re-reviews report no
remaining Critical or Important finding.

This qualifies the bounded Recipe Console Fleet capability and its approved
Direction A visual baseline. It does not qualify Ready-State #3, hide or cut
over the legacy Fleet row, change the default, or retire any alias, rebuild,
export, rollback, public export, or existing control contract. Iterations
At that checkpoint Iterations 11–12 still owned contextual Advanced
diagnostics, safe lazy legacy routes and documented stateful exceptions, the
default flip, and final desktop/mobile/keyboard/reduced-motion/non-hover
accessibility proof. The qualified Iteration 11 result follows.

## Iteration 11 Advanced diagnostics fidelity addendum

Direction A remains unchanged. Advanced replaces the old nine-link preview
with one quiet evidence ledger: a bounded exact context table followed by
Direct Diagnostics, Workflow Fallbacks, and Advanced Legacy lists. The primary
rail remains Execute, Monitor, Analyze, Tune, Fleet, and Advanced. Exact IDs use
monospace/ltr presentation, contextual links remain persistent without hover,
and the compact rail/bottom navigation preserves labeled selected states.

Four deterministic Darwin baselines were added and inspected at original
resolution:

- desktop 1440×900:
  `28db7746c79ab0a69066bb0cf0c87840b1e1029fe5b224940b818c36a9f03555`
- tablet 900×900:
  `6a48242bd188d35de40895234776e41c6aa8c952609bf6d0c8c9df6e5e598f57`
- genuine-touch landscape 932×430:
  `fc9c6c22820dfa69f478419ca7ecb886eddc677217d55852f7819fe798fe24ff`
- genuine-touch portrait 430×932:
  `8bba8b60bbe96719258544d3b2e0d202d363a9cb101ac4de275e76fec52ed219`

The initial tablet/landscape captures exposed selected `Advanced` text
clipping because a global button rule outranked the compact module selector.
The corrected selector produces exact 10px tablet and 9px landscape labels
inside both button and navigation bounds. The same intentional correction
changed the existing Tune short-landscape baseline; native inspection found no
content/hierarchy drift and approved hash
`4e4ae5c8bf5b3f81de35d914d44c7921793c9e3eb7430a93e3e957c9d8057468`.
Advanced short-landscape content owns a local scroller rather than escaping the
shell. The final no-update Advanced baseline gate passes 4/4 and the full
responsive/CSS gate passes 31/31.

Keyboard-only evidence covers roving primary and legacy tabs, all five Monitor
handoffs, exact legacy return, one-shot current-view focus restoration, ordinary
SPA focus non-steal, safe-panel unmount, and retained-hidden/inert panel focus
recovery. Genuine touch, 44px targets, reduced motion, zero document overflow,
long/bidi identity, loading/empty/partial/stale/offline/permission/schema and
missing-context states, and both CSS load orders pass.

The complete Recipe Console configuration passes 190 with one configured-live
skip; the preserved legacy matrix passes 30 with two exhaustive configured-
stack skips. The exact prerequisite is `Set RALLAR_BLACK_BOX_FULL_STACK=1 with
Postgres-backed apps/api-v1, apps/rallar-black-box-control-server, and
apps/rallar-black-box available.` The in-app Browser was unavailable exactly
as `Browser runtime unavailable after setup failure: Cannot redefine property:
process`; terminal Playwright remains fallback evidence. Independent visual,
browser, React/accessibility, URL/security, and lifetime reviews report no
remaining Critical or Important finding. The final review's production-return
builder finding is closed in `78e2c13`: both return callers now share one
neutral bounded builder, the canonical Advanced surface wins the aggregate
4,096-byte budget, and exact unit/browser regressions pass re-review.

This qualifies Ready-State #11–#13 and the Advanced visual bridge. It does not
qualify configured-live #3, final Ready-State #1/#14, retire a legacy row,
change a public/control contract, or flip the default. Iteration 12 owns those
remaining proofs and the registered legacy touch/overflow debts.
