# Recipe Console Migration Register

Status: canonical migration register; Iteration 4 guided Execute in progress, all workflow rows uncut
Evidence/status date: 2026-07-12

This register is the source of truth for surface-by-surface strangler status, compatibility aliases, mount policy, state ownership, cutover proof, rollback, and audit evidence. Product intent and Ready-State traceability live in the [Recipe Console product spec](./recipe-console-product-spec.md). Iteration status, binding decisions, baseline validation, and risks live in the [SPA reimplementation plan](../../../playground/rallar-black-box-spa-reimplementation-plan.md).

No row below is newly cut over or newly hidden. `Consolidated` describes navigation that already exists in `app-tabs.ts`; it is not Recipe Console parity. All rollback URLs are SPA-root-relative and intentionally use the current compatibility codec.

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

These commits are foundations, not workflow parity or cutover evidence. The
seeded Execute target/action plane remains until the pure workflow and visible
lifecycle replacement pass, and both legacy rows retain their primary
visibility, mounts, deep links, and rollback URLs.

Pure Execute state now also owns canonical recipe/default selection without
index fallback, URL dependency clearing, safe target-context reconciliation,
deterministic manifests and full fingerprints, exact resolution evidence,
explicit action arming/policy, mutation-response classification, and
newer-only query reconciliation. The final slice passed 104/104 focused tests,
SPA typecheck, bounded pure-module gates, and independent review. A review
found and corrected equal-millisecond stale-query overwrite of mutation truth;
terminal advancement remains the only equal-timestamp query exception. This
still changes no visible owner, row status, mount, hide, or rollback route.

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
distributed lifecycle. The configured `recipe-console-execute.spec.ts`
acceptance remains absent; visible create, stage, start, monitor, cancel, and
export plus the configured lifecycle proof remain Iterations 4–5, so Ready-State
#3 stays open. This checkpoint changes no legacy route, alias, deep-link
semantics, default, navigation visibility, existing legacy mount policy,
rollback URL, endpoint, legacy owner, hide, or cutover. No existing export was
removed, renamed, or made incompatible; additive structured HTTP/protocol error
exports preserve message compatibility without changing the server protocol.
The deterministic Execute preview remains explicitly preview-only, and the
legacy default remains until Iteration 12.

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
| `runner.recipes` | `RunnerRecipesPanel`, `RunnerReadinessPanel`, `RunnerAgentSetupPanel`, `ControlAgentBoardPanel`; `/?workspace=black-box-runner&tab=recipes`, aliases `catalog`, `recipes` | Service/auth/TURN/control readiness, agent launch/setup and identity board, recipe catalog/search/profile/source filters, preflight, target resolution, local launch, distributed create/stage/start handoff, and visible failure/status feedback. | `Execute` | `src/recipe-console/execute/**` and `src/recipe-console/control/**` | Existing consolidated primary tab; mounted only while `recipes` is active. | Lazy route, unmounted when inactive; polling/query lifecycle owned by control services. | Preserve selected recipe/profile as URL/personal default as appropriate; never persist control tokens. Runner-agent launch URL and ticket fragment behavior are compatibility constraints. | Iteration 3 implements the Recipe Console control connection, URL control/agent selection, and canonical agent-board backbone. Recipe selection, target resolution, and live actions remain Iteration 4 work; no legacy cutover. | `tests/playwright/rallar-black-box/recipe-console-execute.spec.ts` — `runs a simulated distributed ACK recipe through visible controls`; `diagnoses non-targetable agents before staging` | `/?workspace=black-box-runner&tab=recipes` | `App.tsx`, `app-tabs.ts`, `runner-agent-launch.ts`; `a7df46f`; 2026-07-12 |
| `runner.runs` | `RunnerRunsPanel`, `RunVerdictPanel`, `CausalTrailPanel`, `RtcPerformancePanel`, `DistributedRunSummary`, participant board; `/?workspace=black-box-runner&tab=runs`, alias `runs` | Select and refresh live/historical distributed runs, retain last run handoff, import/export/copy artifacts, show local verdict/failures/report, select synthetic evidence, and compose nested monitor/analyze/compare surfaces. | `Monitor` | `src/recipe-console/monitor/**` with selection/history adapters under `src/recipe-console/control/**` | Existing consolidated primary tab; mounted only while `runs` is active. It polls a selected non-terminal run and auto-loads terminal artifacts. | Lazy route, unmounted when inactive; run polling belongs to a view-independent query/service. | Selected run, control run, and filters belong in URL state. Tokens and artifact payloads stay in memory. Poll ownership must move before unmounting. | Iteration 3 implements root query ownership, last-good control evidence, and URL-backed control-run/agent selection. Distributed Monitor parity and workflow cutover remain Iteration 5; the legacy Runs surface is unchanged. | `tests/playwright/rallar-black-box/recipe-console-monitor.spec.ts` — `preserves last-known evidence while a selected run refresh fails` | `/?workspace=black-box-runner&tab=runs` | `App.tsx` (`RunnerRunsPanel`), `control-run-manager.ts`; `a7df46f`; 2026-07-12 |
| `runner.distributed-monitor` | `DistributedRunMonitorPanel`, nested composite/timeline/diagnostic/progress views inside `RunnerRunsPanel` and `DistributedRecipesPanel`; runs/distributed routes | Verdict, failure-first evidence, agent/recipe progress, ACK/barrier readiness, lifecycle timeline, structured WS/RTC diagnostics, latency, event filtering, composite loop/parallel/wait/assert drilldowns, and artifact validation. | `Monitor` | `src/recipe-console/monitor/**`; deterministic derivation remains in `packages/shared-test/rallar-bb-test/**` | Mounted only with its owning active runs/distributed tree and selected monitor. | Lazy `Monitor` route; inactive view unmounted; shared deterministic helpers only. | Selection/filter fields use v1 URL state. No duplicate monitor derivation in React. | Implemented legacy evidence; no Recipe Console parity or cutover. | `tests/playwright/rallar-black-box/recipe-console-monitor.spec.ts` — `opens all available correlated evidence from a failure row` | `/?workspace=black-box-runner&tab=runs` or `/?workspace=black-box-runner&tab=distributed-recipes` | `App.tsx`, `distributed-recipe-execution-iterations.md`; 2026-07-10 |
| `runner.artifact-analysis` | `DistributedRunAnalysisReportPanel`, `ImportedDistributedArtifactAnalysisPanel`, artifact import in `RunnerRunsPanel`; runs route | Live/offline artifact parsing, causal/failure report, missing-file and parse warnings, issue-ready summary/fix/performance markdown, and first actionable failure focus. | `Analyze` | `src/recipe-console/analyze/**`; validators/parsers in `packages/shared-test/rallar-bb-test/**` | Mounted only under active Runs when analysis exists. | Lazy `Analyze` route, unmounted when inactive; imported files remain in bounded in-memory state. | Profile/version-aware parsing; partial bundles remain usable. Never persist large artifacts locally. | Legacy capability exists; no Recipe Console replacement or cutover. | `tests/playwright/rallar-black-box/recipe-console-analyze.spec.ts` — `imports a partial bundle offline and focuses the first actionable failure` | `/?workspace=black-box-runner&tab=runs` | `App.tsx`, `current-state.md`; 2026-07-10 |
| `runner.compare` | `DistributedRunComparePanel`, `DistributedCompareList`, `compareDistributedRuns`; runs route | Select two runs and show status, recipe, participant, failure, timing, and received-message deltas. | `Tune` | `src/recipe-console/tune/**`; shared compare derivation in `packages/shared-test/rallar-bb-test/**` | Mounted only when Runs is active and at least two runs exist. | Lazy `Tune` route, unmounted when inactive. | `compareLeft`, `compareRight`, and `timingMetric` are v1 URL state; candidate changes are explicit output and never silent mutation. | Legacy comparison exists; no Recipe Console cutover. | `tests/playwright/rallar-black-box/recipe-console-tune.spec.ts` — `compares two runs and emits explicit candidate timing changes without mutation` | `/?workspace=black-box-runner&tab=runs` | `App.tsx`, reimplementation plan; 2026-07-10 |
| `runner.fleet` | `RunnerFleetPanel`, `FleetTimingGroupList`, `FleetTimingStrip`; `/?workspace=black-box-runner&tab=fleet`, aliases `fleet-report`, `fleet-reports` | Live agent board, historical matrix/heatmap, filters, failure signatures, region/provider summaries, timing distributions, deterministic SVG world map and explicit route layers, and report/bundle export. | `Fleet` | First `src/legacy/runner/LegacyFleetRoute.tsx`; then `src/recipe-console/fleet/**` using shared deterministic helpers | Existing consolidated primary tab; active-only mount and active fetch/rebuild lifecycle. | First a behavior-preserving legacy extraction; then a lazy new Fleet route that does not import the legacy panel. | Filters/map layers move to URL state. Explicit coordinates/known lookups remain evidence rules; unresolved locations are not guessed. | Existing consolidated navigation; no new Fleet cutover. | `tests/playwright/rallar-black-box/recipe-console-fleet.spec.ts` — `restores fleet filters and map layers and links a failure signature to its run evidence` | `/?workspace=black-box-runner&tab=fleet` | `App.tsx`, `control-run-manager.ts`, `current-state.md`; 2026-07-10 |
| `runner.builder` | `FlowBuilderPanel`; `tab=builder` (alias `flow`) and compatibility `tab=flow-builder` (alias `flows`) | Compose HTTP, WS, RTC, wait, cleanup, variables, editable flow JSON, SPA recipe export, runner scenario export, schema feedback, and inline recipe execution. | `Advanced` | First `src/legacy/runner/LegacyBuilderRoute.tsx`; focused authoring entry points may live under `src/recipe-console/advanced/**` | Primary `builder` instance is active-only, but a second legacy `flow-builder` pane remains mounted while hidden. | One lazy legacy route, unmounted inactive; any future focused authoring route delegates to shared schema helpers. | Flow JSON/drafts need explicit redacted persistence before removing the temporary stateful mount. No silent recipe mutation. | Existing consolidation to Builder; no Recipe Console cutover or new hide. | `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts` — `opens Flow Builder through tab=flow-builder and preserves an edited flow across the compatibility round trip` | `/?workspace=black-box-runner&tab=flow-builder` | `App.tsx`, `app-tabs.ts`, `current-state.md`; 2026-07-10 |
| `runner.advanced-wrapper` | `RunnerAdvancedPanel`; `tab=advanced` (alias `debug`) with `advancedSurface=<surface>` or `advanced=<surface>` | Switch and deep-link among Workbench, Distributed Recipes, Run Manager, Manual Rallar, and Shared Test raw controls. | `Advanced` | `src/recipe-console/advanced/**` plus `src/legacy/LegacySurfaceRouter.tsx` and registry | Wrapper is mounted even when Advanced is hidden; Workbench and Manual children remain mounted while hidden; other children are selected-only. | Lazy compatibility router mounts exactly one selected legacy route. | Surface selection uses v1 `legacySurface`. Stateful exceptions remain documented per child until persistence/service ownership is proven. | Existing consolidated wrapper only; no Recipe Console cutover. | `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts` — `loads exactly one registered advanced legacy route and restores Recipe Console context on return` | `/?workspace=black-box-runner&tab=advanced&advancedSurface=workbench` | `App.tsx`, `app-tabs.ts`; 2026-07-10 |
| `legacy.manual-rallar` | `ManualRallarWorkbenchPanel`, inbox/history; `tab=manual-rallar` (alias `manual`) → advanced/manual | Configure/join/connect/send/health/close/reset, scoped RTC and delivery matrices, NACK/negative probes, recipe/command export, received data, and command history. | `Advanced` | `src/legacy/runner/LegacyManualRallarRoute.tsx` | Two hidden-capable instances exist; Advanced Manual and the legacy pane stay mounted to preserve drafts/runtime context. | Lazy/unmounted inactive only after explicit redacted draft persistence and runtime-task ownership are proven. | **Temporary stateful exception:** Manual values/payload draft and active runtime work; passwords stripped and JSON redacted. | Preserved legacy; no replacement, cutover, or new hide. | `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts` — `tab=manual-rallar opens advanced manual and preserves redacted drafts without persisting secrets` | `/?workspace=black-box-runner&tab=manual-rallar` | `App.tsx`, `app-tabs.ts`, `current-state.md`; 2026-07-10 |
| `legacy.local-workbench` | `WorkbenchPanel`, `ControlPanel`, bootstrap/configuration/queue/report panels; `tab=local-workbench` (aliases `workbench`, `local`) → advanced/workbench | Local/fake runtime recipe editing/loading/execution/cancel/reset, queue, bootstrap/config, report, and control-agent workspace used by runner-agent launch URLs. | `Advanced` | `src/legacy/runner/LegacyWorkbenchRoute.tsx`; runtime service remains `runtime-store.ts` until deliberately extracted | Advanced and legacy compatibility trees remain mounted while hidden; shared runtime store is process-long. | Lazy/unmounted route after drafts and active execution are owned outside the view; service may remain alive. | **Temporary stateful exception:** recipe/command drafts and active local execution. Preserve `mode=control` launch bootstrap and fragment ticket scrubbing. | Preserved legacy; no replacement, cutover, or new hide. | `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts` — `runner-agent launch URL opens advanced workbench consumes and scrubs the session-ticket fragment` | `/?workspace=black-box-runner&tab=local-workbench` | `App.tsx`, `runner-agent-launch.ts`, `runtime-store.ts`; 2026-07-10 |
| `legacy.run-manager` | `RunManagerPanel`; `tab=run-manager` (aliases `manager`, `control`, `orchestrator`) → advanced/run-manager | Control-server run/agent selection, bounded snapshots, bulk command enqueue, reset/delete, command/result/event inspection, artifact validation/export/copy, JSONL, and failure bundle operations. | `Advanced` | `src/legacy/runner/LegacyRunManagerRoute.tsx`; API calls remain canonical in `control-run-manager.ts` | Selected-only under Advanced; compatibility pane also guards mount by exact legacy tab. | Lazy/unmounted inactive; polling/query ownership extracted before any required background lifecycle continues. | IDs/filters may be URL-backed; token stays memory-only. Existing destructive behavior remains unchanged. | Preserved legacy; no Recipe Console cutover. | `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts` — `tab=run-manager opens the legacy manager and returns with selected run context` | `/?workspace=black-box-runner&tab=run-manager` | `App.tsx`, `control-run-manager.ts`; 2026-07-10 |
| `legacy.distributed-recipes` | `DistributedRecipesPanel` plus preflight/monitor/compare/authoring; `tab=distributed-recipes` (aliases `distributed`, `distributed-runs`, `dist`) → advanced/distributed | Full legacy create/list/read/resolve/stage/start/cancel/export workflow, catalog/manifest/preflight, monitor/history/compare, diagnostics, and schema/AI prompt authoring. | `Advanced` fallback; capabilities migrate to `Execute`, `Monitor`, `Analyze`, and `Tune` | `src/legacy/runner/LegacyDistributedRecipesRoute.tsx`; new feature owners under `src/recipe-console/**`; canonical APIs in `control-run-manager.ts` | Selected-only under Advanced; compatibility pane guards mount by exact legacy tab. | Lazy/unmounted inactive after polling ownership moves to a service. | Selected run, filters, and comparison become URL state; token and artifacts stay memory-only. | Operational fallback preserved; none of its replacements is cut over. | `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts` — `tab=distributed-recipes opens the exact legacy distributed fallback` | `/?workspace=black-box-runner&tab=distributed-recipes` | `App.tsx`, `control-run-manager.ts`, distributed iterations doc; 2026-07-10 |
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
| `diagnostic.event-stream` | `ExecutionFocusPanel`, `CommandHistoryPanel`, `StatsPanel`, `FailurePanel`, `EventStreamPanel`; `/?workspace=rallar&tab=event-stream` or `/?workspace=black-box-runner&tab=event-stream`, aliases `events`, `event` | Selected execution focus, command history, stats, failure list, kind/transport/text filtering, and bounded 40/100/250/500 event windows. | `Monitor` evidence plus `Advanced` full stream | `src/recipe-console/monitor/**` for contextual evidence; `src/legacy/diagnostics/LegacyEventStreamRoute.tsx` for full stream | Mounted while hidden in both workspace modes; filters and selected command survive navigation/reload. | Lazy/unmounted full stream after filters/selection move to URL/personal defaults; event collection is service-owned and bounded. | **Temporary stateful exception:** filter/selection persistence and runtime subscription ownership. No large raw stream persistence. | Existing shared tab; no Recipe Console cutover or new hide. | `tests/playwright/rallar-black-box/recipe-console-monitor.spec.ts` — `opens bounded event evidence from a failure`; `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts` — `restores Event Stream filters and leaves no inactive polling` | `/?workspace=black-box-runner&tab=event-stream` (direct fallback: `/?workspace=rallar&tab=event-stream`) | `App.tsx`, `app-tabs.ts`, `current-state.md`; 2026-07-10 |

## Cutover rule

A row may move from baseline/preserved to cut over only after its exact proof passes, its rollback URL remains verified, its state owner is explicit, and inactive legacy effects are absent or covered by a still-current documented exception. Navigation consolidation alone is never cutover evidence.
