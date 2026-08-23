# Relic Hunters V1 Improvement Plan

## Goal

Improve `apps/relic-hunters-v1` into a clear, modern, playable turn-based Rallar game.

The intended game shape is:

- several authenticated players join the same expedition room
- players pick characters and ready up
- the expedition starts when the party is ready
- each planning round lets every active player choose one action
- the server resolves all submitted actions together
- players win by collecting relic value and escaping before the castle collapses
- Rallar keeps room membership, server push, and optional live RTC position signals synchronized

## Current Assessment

The app compiles and builds, but it is not yet production-quality gameplay.

Validation run:

```text
npm --workspace relic-hunters-v1 run typecheck
npm --workspace relic-hunters-v1 run build
```

Both pass. The production build warns that the Babylon chunk is large, about 3 MB minified and about 693 kB gzip.

### Strengths

- Shared game rules live outside the app in `packages/relic-hunters`, which is the right direction.
- Server writes are serialized per game, which avoids obvious simultaneous-turn write races.
- The app already has a real Rallar-backed flow: auth, rooms, REST commands, WS snapshot events, and RTC position updates.
- The game has enough rules to be interesting: round planning, simultaneous resolution, relics, stealing, health, collapse, escape, and scoring.

### Main Problems

#### 1. UI density and overlapping layout

`src/App.tsx` is doing too much. It is over 3,000 lines and owns auth, room selection, lobby, action drafting, event reveal timing, audio, overlays, map, panels, help, onboarding, victory, and many derived game summaries.

`src/styles.css` is also over 3,000 lines and contains many fixed or absolute overlays. Several components compete for the same screen regions:

- topbar
- side panel
- bottom panel
- scene objective panel
- scene interaction prompt
- turn feedback
- room kind strip
- minimap
- controls HUD
- action nudge
- countdown overlays
- help/onboarding/victory/defeated overlays

This explains the perceived overlap and lack of hierarchy. The layout has no single HUD composition model.

#### 2. Controls are not discoverable enough

The app has keyboard controls and a help overlay, but the primary interaction model is split across:

- pointer lock and WASD roam in the Babylon scene
- click-to-select room meshes
- scene prompts
- side panel action buttons
- dropdowns for move/steal targets
- keyboard action hotkeys
- touch D-pad

The player is not given one obvious "choose plan, confirm plan, wait for party" loop. Some controls are presented as HUD hints, others are buried in the side panel, and some rely on non-obvious 3D scene affordances.

#### 3. Graphics feel noisy and soft

The Babylon scene is ambitious, but the visual stack is heavy and inconsistent:

- procedural castle and room geometry is doing most of the work because real models are not present
- bloom, glow, fog, vignette, grain, blurred shadows, SSAO, and color curves are all active
- the palette is dominated by muted green/blue/brown tones
- small procedural props and labels fight with multiple UI overlays
- `preserveDrawingBuffer` is enabled in the main scene, which is usually not needed for gameplay and can hurt performance

The result is likely atmospheric, but not crisp. It needs an art direction pass before more effects are added.

#### 4. Rallar usage is functional but not disciplined

`src/game/useRelicHunters.ts` calls `rallar.connect()` and then uses rooms, WS messages, and REST fetches. Rallar operations generally call or wait for `connect()` internally, so this is not simply "no wait at all." The issue is that the app lacks an explicit game connection state machine.

Current gaps:

- no clear state distinction between auth restored, middleware connected, room joined, snapshot loaded, and WS listener active
- REST commands are the primary command path, while the server also defines a Rallar WS command topic that the client does not use
- snapshot pushes use `rallar.messages.ws`, but command responses also directly overwrite snapshot state from REST responses
- `RelicScene` sends RTC position updates every 80 ms without a visible connection/room guard or error handling path
- no Rallar health diagnostics are exposed in the UI
- no reconnect/resubscribe recovery model is visible to players

The first Rallar improvement should be a small state-machine facade for the game, not another round of direct calls from UI components.

#### 5. Game rules and presentation are coupled too tightly

The core rules are in `packages/relic-hunters`, but the client contains many additional derived rules and messaging helpers. This makes UI changes risky because it is hard to tell what is canonical game logic versus presentation-only guidance.

The game should have a smaller client-facing view model:

- current player status
- legal actions
- legal targets
- turn status
- room intel
- score/escape objective
- next recommended action

#### 6. Performance and bundle shape need attention

The build warning is expected for Babylon, but the app currently imports most of the 3D stack immediately. The intro scene and main game scene could be code-split. Production should also measure frame time, device pixel ratio, draw calls, mesh count, particle count, and post-processing cost.

## Proposed Iterations

### Iteration 1: Baseline And Triage

Create a reliable baseline before changing behavior.

Status: completed for the currently reachable signed-out baseline. See
[`baseline/iteration-1-baseline.md`](baseline/iteration-1-baseline.md).
Authenticated lobby, planning, waiting, and finished screenshots are blocked
until local server validation/startup is fixed or a fixture harness is added.

Deliverables:

- add a lightweight "known issues" list to this plan as bugs are reproduced
- capture desktop and mobile screenshots for signed-out, lobby, planning, waiting, and finished states
- record current frame time and bundle size
- document current Rallar event flow: login, connect, room refresh, join, snapshot load, WS snapshot event, REST command, RTC position
- add a small manual QA checklist

Exit criteria:

- we can compare UI/scene changes against the current state instead of relying on memory

### Iteration 2: App Shell And HUD Layout

Replace the current free-floating overlay composition with a predictable layout.

Status: initial implementation complete. The app now renders through a
`GameHudLayout` with named scene, top, side, bottom, floating, and overlay
regions. The top status bar and bottom chronicle are split into top-level
components, the bottom HUD has a compact signed-out mode, and floating scene
hints reserve space above the bottom HUD. Signed-out desktop and mobile smoke
screenshots are stored in `baseline/screenshots/iteration-2-signed-out-*.png`.
Authenticated layout screenshots remain blocked by the local server validation
issue documented in iteration 1.

Deliverables:

- split `App.tsx` into top-level screen components
- introduce a single HUD layout component with named regions
- reserve stable regions for top status, side actions, bottom timeline, and scene prompts
- remove or merge overlapping HUD elements
- make mobile layout a first-class layout, not a pile of fixed-position overrides

Suggested component direction:

```text
RelicHuntersApp
    AuthScreen
    ExpeditionShell
        GameSceneLayer
        GameHud
            TopStatusBar
            ActionPanel
            PartyPanel
            TimelinePanel
            ScenePromptLayer
```

Exit criteria:

- no core controls overlap at desktop, tablet, or mobile widths
- the planning turn loop is visible without opening help

### Iteration 3: Game View Model

Move client-side derived gameplay state out of `App.tsx`.

Status: initial implementation complete. `src/game/game-view-model.ts` now
derives the local player, current room, legal move and steal targets, action
consequences, submit readiness, objective text, progress, and warnings from a
published relic snapshot. `App.tsx` consumes that view model instead of
recomputing the core planning state inline. Focused Vitest coverage uses
snapshots produced through `packages/relic-hunters` shared rules.

Deliverables:

- create a `game-view-model.ts` module
- derive current player, current room, legal actions, legal move targets, legal steal targets, objective, turn status, and warnings
- reuse server/shared rules where possible
- add tests for the view model using snapshots from `packages/relic-hunters`

Exit criteria:

- UI components receive simple view-model data rather than recomputing game rules

### Iteration 4: Rallar Game Runtime Facade

Create a focused facade around Rallar and game API usage.

Status: initial implementation complete. Rallar and relic API calls now go
through `src/game/relic-hunters-runtime.ts`, while `useRelicHunters` acts as
the React state adapter. The hook exposes explicit phases for authentication,
connection, room join, ready, degraded, and error states, installs WS snapshot
and room listeners inside the connect-and-hydrate path, guards duplicate
in-flight commands, and publishes development diagnostics for auth, middleware,
room, snapshot, WS, room listener, and RTC readiness. `RelicScene` receives an
`rtcReady` flag and does not subscribe to or send RTC position updates until the
runtime has a connected middleware session and current room.

Deliverables:

- replace direct Rallar calls in React components with a `RelicHuntersRuntime`
- explicit states: `signed-out`, `authenticating`, `connecting`, `connected`, `joining-room`, `ready`, `degraded`, `error`
- one `connectAndHydrate` path that waits for Rallar connect, room state, snapshot fetch, and listener setup
- guarded command submission with in-flight state and duplicate-submit prevention
- connection health diagnostics visible in development UI
- clear reconnect/resubscribe behavior

Exit criteria:

- UI can show exactly what it is waiting for
- RTC position sending is disabled until Rallar is connected and a room is current

### Iteration 5: Command Transport Decision

Choose and simplify the authoritative command path.

Status: initial implementation complete. The browser app now treats REST as
the single authoritative command transport through `RelicHuntersRuntime`, with
Rallar WS reserved for live snapshot fanout. Runtime diagnostics expose the
chosen command and snapshot transports, and the React adapter accepts snapshots
through a monotonic guard that rejects wrong-room or older same-room snapshots.
The server still registers the Rallar WS command topic for server-level
compatibility tests and future transport experiments, but the browser client
does not send gameplay commands over that topic.

Options:

- keep REST as the authoritative command path and use Rallar WS only for snapshot pushes
- move commands to `rallar.messages.ws` and use REST only for snapshot/bootstrap/recovery

Recommended first step:

- keep REST commands for reliability and simpler HTTP error handling
- remove unused client assumptions around WS commands
- document why the server still defines the WS command topic, or defer that topic until the client uses it

Exit criteria:

- one primary command path is documented and tested
- snapshot updates are monotonic and do not flicker between REST response and WS push

### Iteration 6: Controls Pass

Make the turn controls obvious and robust.

Status: initial implementation complete. Planning controls now render only
during active planning for an active local hunter, and the round plan panel is
the primary surface for action selection, target selection, timer, turn status,
and submission. Move and steal targets use explicit button choices instead of
dropdowns, scene/map clicks only prime the same panel state, locked plans are
shown even after a reload or remote snapshot, and the visible shortcut strip
matches the implemented number, arrow-target, and Enter controls. Touch
movement controls are positioned inside the scene layer so they do not cover the
primary HUD on mobile.

Deliverables:

- make the main action panel the primary interaction surface
- replace target dropdowns with clear target buttons or a compact segmented target list
- add explicit "Plan locked" and "Waiting for other players" states
- make scene clicks optional shortcuts, not required knowledge
- make keyboard shortcuts mirror visible controls
- add touch controls only when they do not overlap primary UI

Exit criteria:

- a first-time player can login, join, start, choose an action, and understand the waiting state without reading a help overlay

### Iteration 7: Visual Direction And Babylon Cleanup

Make the game scene clearer before adding more content.

Status: in progress. The first pass prioritized playability and browser
stability over new visual content. The opening and lobby surfaces now mount a
lightweight Babylon ambient scene, while the planning scene uses a capped render
loop with lighter shadows/SSAO/bloom and paints an early frame so canvas
readiness checks do not race heavy setup. Blocking
intro/onboarding flows are disabled by default while the playable loop is
stabilized. Shared gameplay rules were also tightened: Entrance no longer
contains a hidden relic, relic discoveries immediately create durable room
investigations, and route hints prefer higher-value adjacent relic leads. The
second pass disables
`preserveDrawingBuffer`, replaces retained-buffer test readiness with an
explicit canvas `data-scene-ready` signal, simplifies player labels to
player-facing names, and records a first asset plan in
`docs/visual-direction.md`.

Deliverables:

- define visual targets for rooms, exits, relics, players, and danger
- reduce post-processing stack to a crisp baseline
- disable unnecessary `preserveDrawingBuffer`
- tune device pixel ratio and engine scaling for sharpness/performance
- reduce bloom/glow/vignette/grain until geometry reads clearly
- separate debug labels from player-facing labels
- add a simple asset plan for real castle/room/player models

Exit criteria:

- rooms, exits, players, relics, and current objective are readable at a glance
- the scene does not feel blurred by effects

### Iteration 8: Scene Architecture

Reduce `RelicScene.tsx` risk.

Status: in progress. First architecture slice complete: the React lifecycle now
creates Babylon through a `createRelicSceneRuntime` boundary, capped render-loop
scheduling lives in `src/game/scene/renderLoop.ts`, and cosmetic RTC position
send/receive lives in `src/game/scene/networking.ts`. `RelicScene.tsx` still
owns most scene sync, labels, avatars, relic meshes, and event effects, so the
next useful slice is to move either event effects or player/relic sync behind a
module boundary.

Deliverables:

- move Babylon scene construction into `createRelicSceneRuntime`
- isolate render-loop updates into modules
- isolate RTC position sync into a small scene networking adapter
- isolate materials/effects from gameplay sync
- add lifecycle cleanup tests or smoke checks where practical

Exit criteria:

- scene lifecycle is understandable and changes can be made without touching the whole 2,500-line component

### Iteration 9: Lobby And Multiplayer Flow

Make multiplayer readiness and room membership reliable.

Status: in progress. First lobby-policy pass complete: the SPA now separates
online room members from joined expedition hunters, labels the Keeper/admin in
the lobby roster, disables Keeper start while connected room members have not
joined the expedition, explains stale/offline players in the party-change
prompt, and shared rules reject non-admin start commands.

Deliverables:

- show online members versus joined expedition players clearly
- handle player disconnect/reconnect
- decide if disconnected players block turn resolution
- make admin/keeper role explicit
- make start conditions clear
- add a server-side or shared policy for stale participants if needed

Exit criteria:

- players understand why the game can or cannot start or advance

### Iteration 10: Turn Timeline And Feedback

Clarify simultaneous turn resolution.

Status: in progress. First consolidation pass complete: normal play now uses one
bottom current-turn summary plus one grouped turn timeline. The previous floating
turn feedback panel, post-round digest overlay, personal round card, and compact
diff strip have been removed from the standard path. Timeline entries are grouped
by round and labelled as Reveal, Your Action, Party Action, Castle Reaction, or
Result. Iteration 21 adds the missing shared review phase so these resolved
events are watched before the next planning turn begins.

Deliverables:

- replace many competing feedback overlays with one event timeline and one current-turn summary
- group events by round
- distinguish "your action", "party action", "castle reaction", and "result"
- make new events visible without blocking controls for too long

Exit criteria:

- players understand what happened after every round

### Iteration 11: Tests And Playwright Coverage

Add automated coverage around the real gameplay loop.

Status: in progress. First coverage pass complete: turn summary logic is now in
`src/game/turn-summary.ts` with unit tests, view-model action legality has
additional exit/defeated-player coverage, the Rallar runtime fake-dependency
tests now cover no-session hydration, room create/join hydration, and reset
delegation, and Playwright now drives a mocked browser loop through register,
room create, join expedition, start, submit, and resolved timeline feedback. A
desktop/mobile lobby screenshot smoke test was added. The real two-client
propagation gap is now split out as
[Iteration 12](#iteration-12-two-client-propagation-and-snapshot-recovery), and
baseline visual snapshots are split out as
[Iteration 14](#iteration-14-visual-baselines-and-scene-architecture-follow-up).

Deliverables:

- unit tests for view model
- unit tests for action legality and turn summaries
- browser tests for login/register, room create/join, join expedition, start, submit, wait, resolve
- layout screenshot tests for core viewports
- Rallar runtime tests with fake Rallar facade where possible

Exit criteria:

- future UI and Rallar changes do not regress the basic playable loop

### Iteration 12: Two-Client Propagation And Snapshot Recovery

Prove and harden the data flow that originally made the game feel unplayable.

Follow-up from:
[Iteration 4](#iteration-4-rallar-game-runtime-facade),
[Iteration 5](#iteration-5-command-transport-decision),
[Iteration 9](#iteration-9-lobby-and-multiplayer-flow), and
[Iteration 11](#iteration-11-tests-and-playwright-coverage).

Status: completed for the current propagation target. Snapshot
ordering now rejects equal-timestamp candidates that have less complete
event/submission/investigation state, runtime diagnostics expose accepted
snapshot metadata and ignored snapshot reasons, the room list exposes stable
room ids for browser automation, and a gated full-stack Playwright spec now
drives two browsers through create room, second-client join, expedition join,
start, submit/wait/resolve, reload recovery, reset, and rejoin against the
paired Relic server/Rallar runtime. The full-stack spec is skipped by default,
runs with `RELIC_HUNTERS_FULL_STACK=1`, and has passed against the paired local
server.

Deliverables:

- add a real two-browser/client propagation test using the paired Relic server
  and Rallar runtime, not only a mocked single-browser backend: first gated spec
  added in `tests/playwright/relic-hunters/full-stack-propagation.spec.ts`
- cover create room, second-client room join, join expedition, start, submit,
  wait, resolve, and reset/rejoin propagation: first gated spec covers these
  plus a reload recovery check
- compare both clients' room id, snapshot phase, round, submissions, event ids,
  active player counts, and accepted snapshot metadata after each command: first
  gated spec compares this metadata through a development-only runtime hook
- add diagnostics or test hooks that expose ignored snapshot reasons and latest
  accepted snapshot source per client: first pass complete
- fix snapshot acceptance if equal-timestamp or less-complete snapshots can
  replace richer state under fast REST/WS ordering: first pass complete with
  unit coverage
- add a reconnect/resubscribe recovery check for room and snapshot listeners:
  first gated spec reloads a client and verifies snapshot rehydration
- document the authoritative propagation contract in
  `docs/runtime-data-flow.md`: first pass complete

Exit criteria:

- two independent clients reliably converge after each authoritative command in
  the gated full-stack run
- reconnect recovery has either automated coverage or a documented manual
  procedure with known limitations

### Iteration 13: Stale Participant Policy And Turn Blocking

Decide what happens when joined expedition players disconnect, go stale, or
leave before submitting a round plan.

Follow-up from:
[Iteration 9](#iteration-9-lobby-and-multiplayer-flow) and
[Iteration 12](#iteration-12-two-client-propagation-and-snapshot-recovery).

Status: in progress. First stale-participant policy pass complete: active
hunters can now force-resolve a planning round after the round timer expires,
and missing plans are skipped instead of blocking forever. The shared rules
define the new `force-resolve-round` command, the SPA exposes it only after the
timer reaches zero while hunters are still waiting, runtime command transport
coverage includes it, and browser coverage verifies the command from the timed
out planning UI.

Deliverables:

- decide the product rule for stale joined players: block, keeper-remove,
  auto-skip after timeout, auto-defeat, or reset-only: first pass chooses
  explicit auto-skip after timeout, triggered by any active hunter
- implement the chosen policy in `packages/relic-hunters` and
  `apps/relic-hunter-server-v1` if the rule changes: shared command/rule
  implemented; server accepts it through the shared command validator
- expose the policy clearly in the lobby, waiting, and party-change states:
  first pass updates the party-change copy and timed-out planning controls
- cover the policy with shared-rule tests and browser/runtime tests: first pass
  complete
- document any server/Rallar dependency outside the Relic app/server/package
  before changing that external code

Exit criteria:

- players understand why a round is waiting and have a supported way to recover
  from stale participants after the timer expires

### Iteration 14: Visual Baselines And Scene Architecture Follow-Up

Finish the visual and scene-safety work that started before the test pass.

Follow-up from:
[Iteration 7](#iteration-7-visual-direction-and-babylon-cleanup),
[Iteration 8](#iteration-8-scene-architecture), and
[Iteration 11](#iteration-11-tests-and-playwright-coverage).

Status: in progress. Iterations 7 and 8 were first slices; `RelicScene.tsx`
still owns too many responsibilities, and Iteration 11 left baseline visual
snapshots open. A small navigation follow-up is complete: signed-in side menus
now have sticky section jumps, extra-wide screens use a wider/two-column desktop
layout, the desktop bottom HUD stays out of the right column, and mobile no
longer clips the side-panel menu. A crispness follow-up is also complete:
gameplay rendering now uses high-DPI/native canvas scaling, less fog/bloom/glow,
lighter SSAO/grain/vignette, sharper shadows, disabled depth of field, a 45 fps
gameplay cap, and faster avatar roam/interpolation. The larger Japanese castle
visual upgrade track now has a dedicated implementation plan in
`implementation-plan-for-scene-upgrades.md`, and its S1 pass now writes the
opening, lobby, planning, waiting/locked, resolved timeline, and finished
baseline screenshots. Its S2 pass now adds the first reusable Japanese castle
kit and routes gameplay room shells through it. Its S3 pass adds a dedicated
room identity mapping plus stronger per-kind scene silhouettes and split-party
baseline coverage. Its S4 pass adds a `scene/cameraModes.ts` boundary, makes
idle planning default to a tactical castle overview, preserves active roam and
inspection camera paths, and exposes the rendered mode through
`data-camera-mode` for browser baselines. Its S5 pass adds a
`scene/avatarPresentation.ts` boundary, larger readable procedural hunters,
idle/move/arrival/locked/escaped/defeated presentation states, and focused
avatar state tests. Its S6 pass adds a `scene/lightingPresets.ts` boundary,
day/lantern/night/sunset render presets, brighter opening lighting, and browser
baseline assertions for the active lighting preset. Its S7 pass adds a
`scene/assetPipeline.ts` decision boundary, browser-exported scene metrics,
`scene-upgrade-metrics.json`, and a procedural-first asset decision with a
future hybrid glTF gate. Its S8 pass adds a `scene/sceneCost.ts` boundary,
active-effect-room selection, reduced per-room flame emitters, active
particle/light metrics, and paused inactive room effects. Its S9 pass adds a
`scene/sceneBatching.ts` boundary, static room mesh batching by material, and
static batch metrics while keeping interactive clue/action meshes separate. Its
S10 pass adds a `scene/sceneEventBudget.ts` boundary, limits simultaneous scene
animation cues, exports active effect metrics, and resets draw-call metrics per
rendered frame. Its S11 pass keeps the gameplay scene mounted during review,
queues reveal cues sequentially, and expands the final collapse presentation.

Deliverables:

- add baseline screenshot coverage for signed-out, lobby, planning, waiting,
  resolved timeline, and finished states at core desktop/mobile viewports: first
  pass complete in the scene upgrade S1 track
- move either event effects or player/relic scene sync behind a module boundary
- keep fallback tactical rendering covered by browser smoke checks
- add a tactical camera mode boundary and verify the rendered planning mode:
  first pass complete in the scene upgrade S4 track
- add an avatar presentation boundary and readable tactical-distance hunter
  states: first pass complete in the scene upgrade S5 track
- add lighting preset boundaries and verify rendered day/interior/finished
  presets: first pass complete in the scene upgrade S6 track
- add an asset pipeline decision boundary, browser scene metrics, and future
  hybrid asset gate: first pass complete in the scene upgrade S7 track
- add a scene-cost boundary and cap active room lights/particles in tactical
  views: first pass complete in the scene upgrade S8 track
- add a static room batching boundary and reduce repeated procedural mesh cost:
  first pass complete in the scene upgrade S9 track
- add a scene event-cue budget and corrected per-frame draw-call metrics: first
  pass complete in the scene upgrade S10 track
- add review/finale scene playback that keeps all clients watching the same
  resolved round before the next turn: first pass complete in Iteration 21 and
  the scene upgrade S11 track
- verify labels, prompts, minimap, and bottom HUD do not overlap at the
  captured viewports
- include the extra-wide side menu layout in visual smoke coverage so the
  Rooms, Party/Plan, Map, and Intel controls stay reachable
- refresh `docs/visual-direction.md` with the current procedural-vs-asset plan
  and concrete modern visual direction: first pass complete

Exit criteria:

- scene changes have visual baselines, and one more high-risk scene subsystem is
  no longer embedded directly in `RelicScene.tsx`

### Iteration 15: Performance And Production Readiness

Harden the app after the core loop is readable.

Follow-up from:
[Iteration 7](#iteration-7-visual-direction-and-babylon-cleanup),
[Iteration 8](#iteration-8-scene-architecture),
[Iteration 12](#iteration-12-two-client-propagation-and-snapshot-recovery), and
[Iteration 14](#iteration-14-visual-baselines-and-scene-architecture-follow-up).

Status: planned. This was previously numbered Iteration 12, but should come
after multiplayer convergence and visual baselines so production measurements
reflect the playable app shape.

Deliverables:

- code-split intro scene and game scene
- lazy-load Babylon-heavy modules
- add frame-time diagnostics in development mode
- add fallback rendering for weak devices
- add error boundaries around scene runtime
- document deployment configuration for API base URL and server pairing

Exit criteria:

- production build size and runtime performance are understood and acceptable

### Iteration 16: Rallar Room Fanout And Reload Recovery

Fix the external Rallar-side propagation bug found while validating Iteration 12.

Follow-up from:
[Iteration 12](#iteration-12-two-client-propagation-and-snapshot-recovery) and
the reported failure where a second browser did not receive room-scoped game
updates after another browser joined or started the expedition.

Status: completed. This intentionally touched Rallar shared-server code because
the room recipient cache lagged behind recent room membership writes. The
state-sync publisher now writes client/group snapshots into the in-process
recipient cache before queuing WS broadcast work, so immediate relic room
fanout sees newly joined sessions. The SPA also persists the current Relic room
id and rejoins it during reload hydration before fetching the authoritative
snapshot.

Deliverables:

- update `packages/shared-server/rallar-system/state-sync/state-sync-publisher.ts` so
  local recipient caches are current before room-scoped live fanout depends on
  them
- persist and restore the current Relic room id in
  `apps/relic-hunters-v1/src/game/relic-hunters-runtime.ts`
- prove join, start, submit, reload, reset, and rejoin convergence with
  `RELIC_HUNTERS_FULL_STACK=1`
- document the Rallar dependency in `docs/runtime-data-flow.md`

Exit criteria:

- two live browsers converge through the paired Relic server after room join,
  expedition start, round resolution, reload hydration, reset, and rejoin

### Iteration 17: Remote Avatar RTC Routing

Fix the app-side RTC routing bug found while checking remote player avatar
tracking.

Follow-up from:
[Iteration 8](#iteration-8-scene-architecture-and-runtime-split),
[Iteration 12](#iteration-12-two-client-propagation-and-snapshot-recovery), and
[Iteration 16](#iteration-16-rallar-room-fanout-and-reload-recovery).

Status: completed. The scene networking adapter was still calling
`rallar.messages.rtc.send()` without planned RTC next hops. Current Rallar
returns `no-route` for that shape instead of silently fanning out, so remote
browsers never received live avatar coordinates. The adapter now dedupes
`rallar.rtc.readyPeerIds()` into `nextHopPeerIds`, includes the Relic game room
id, sends the avatar room id plus room-relative offsets, uses one-hop
best-effort delivery, and skips without throttling while no RTC peer is
routable. The app workspace test command now runs the existing
`apps/relic-hunters-v1/tests` suite, including focused regressions for this send
and receive path.

Deliverables:

- update `apps/relic-hunters-v1/src/game/scene/networking.ts` so avatar
  position sends use explicit ready RTC peer targets
- add focused Vitest coverage for routed sends, room-relative receive
  resolution, and no-route/no-throttle behavior
- repair the app workspace test script and runtime test fake dependency shape
- document the RTC avatar routing contract in `docs/runtime-data-flow.md`

Exit criteria:

- remote avatar position sends produce planned Rallar RTC transport messages
  whenever at least one peer has an open reliable RTC lane

### Iteration 18: RTC Snapshot Repair

Fix the game-state/UI divergence found after avatar RTC started delivering
coordinates: two clients could continue rendering different public snapshots,
so remote avatar coordinates alone made the scene look plausible while room
state, action state, and UI panels stayed out of sync.

Follow-up from:
[Iteration 12](#iteration-12-two-client-propagation-and-snapshot-recovery),
[Iteration 16](#iteration-16-rallar-room-fanout-and-reload-recovery), and
[Iteration 17](#iteration-17-remote-avatar-rtc-routing).

Status: completed. Rallar WS remains the normal server fanout path and REST
remains the command path, but accepted public snapshots are now also published
over Rallar RTC to ready peers. Incoming RTC snapshots are accepted only for the
currently joined Relic room and still pass through the existing timestamp,
round, phase, and completeness ordering gate. The runtime also republishes the
current snapshot periodically while RTC is ready, giving late or temporarily
stale peers a repair signal without treating RTC as command authority.

Deliverables:

- subscribe to Relic snapshot messages over `rallar.messages.rtc`
- publish accepted non-RTC public snapshots to `rallar.rtc.readyPeerIds()`
- periodically republish the current accepted snapshot while RTC is ready
- keep RTC snapshots on the same acceptance path as REST and WS snapshots
- add focused runtime coverage for the RTC snapshot listener and publisher

Exit criteria:

- a client that misses a WS snapshot can accept a newer or equally complete
  peer snapshot over RTC and converge before room/avatar UI drift becomes
  permanent

### Iteration 19: Timed-Out Round Snapshot Repair

Fix the remaining timeout-resolution UI divergence: when one client
force-resolved an overdue round, another client could miss both the WS snapshot
and the RTC repair snapshot and keep showing the stale timed-out controls.

Follow-up from:
[Iteration 13](#iteration-13-stale-participant-policy-and-turn-blocking) and
[Iteration 18](#iteration-18-rtc-snapshot-repair).

Status: completed. The SPA now starts a narrow authoritative snapshot repair
poll once a planning round reaches its deadline while active hunters are still
waiting. The poll uses the regular REST snapshot endpoint, accepts the result
through the same ordering gate as bootstrap/WS/RTC snapshots, republishes
accepted repairs over RTC, and stops automatically when a newer snapshot
advances the round or clears the waiting state. Browser coverage now verifies
that an expired round can repair from the force-resolved server snapshot and
clear the timed-out UI.

Deliverables:

- add a `timeout-repair` snapshot source for diagnostics and ordering
- poll the authoritative room snapshot only after the planning deadline when
  active players are still waiting
- reuse the existing snapshot acceptance policy so stale timeout snapshots
  cannot replace newer local state
- add browser-level regression coverage for a timed-out force-resolved round
  catching up through authoritative snapshot polling
- document the timeout repair path in `docs/runtime-data-flow.md`

Exit criteria:

- a peer that misses push-based timeout resolution can still converge from the
  server snapshot without staying stuck on the stale force-resolve UI

### Iteration 20: Scene Movement Input And Stale RTC Room Guard

Fix the reported avatar movement dead end where clicking rooms in the Babylon
scene selected rooms without drafting movement, and stale live RTC avatar
coordinates could keep an avatar visually pinned to a previous room after the
authoritative snapshot had moved that player.

Follow-up from:
[Iteration 14](#iteration-14-visual-baselines-and-scene-architecture-follow-up),
[Iteration 17](#iteration-17-remote-avatar-rtc-routing), and
[Iteration 18](#iteration-18-rtc-snapshot-repair).

Status: completed. `src/game/scene/movement.ts` now converts a picked legal
adjacent room into a move draft during planning. `RelicScene` uses that helper
before falling back to selection-only room clicks, so scene interaction can
prime movement without directly submitting a turn plan. `scene/networking.ts`
now rejects fresh-looking RTC avatar coordinates when their payload room no
longer matches the player's snapshot room, and `RelicScene` clears those stale
remote entries during player sync.

Deliverables:

- add a tested scene movement helper for legal adjacent room picks
- wire Babylon room clicks through the helper before selection-only behavior
- reject stale-room RTC avatar coordinates so snapshot room movement wins
- document the movement and stale RTC room contracts

Exit criteria:

- clicking a legal adjacent room in planning primes a move draft, and stale RTC
  position packets cannot prevent snapshot-driven avatar room movement

### Iteration 21: Round Review And Finale Reveal

Turn simultaneous resolution into a visible shared reveal phase instead of an
instant jump into the next planning turn.

Follow-up from:
[Iteration 10](#iteration-10-turn-timeline-and-feedback),
[Iteration 12](#iteration-12-two-client-propagation-and-snapshot-recovery),
[Iteration 18](#iteration-18-rtc-snapshot-repair), and
[Iteration 20](#iteration-20-scene-movement-input-and-stale-rtc-room-guard).

Status: completed for the first shared reveal pass. Shared rules now resolve a
round into `phase: review`, clear submitted plans, keep the resolved event list
visible, and reject new gameplay commands until a `continue-review` command
advances to the next planning turn or finale. The SPA mounts the gameplay scene
during review with planning input disabled, shows a round review command panel,
and exposes `continueReview()` through the runtime hook. Snapshot ordering now
treats review as a monotonic phase between planning and finished for same-round
snapshots. The scene queues new event animation cues for sequential playback and
stages the final `game_finished` cue as a larger collapse/escape beat.

Deliverables:

- add `review` to the shared public game phase model
- split round resolution from round advancement in `packages/relic-hunters`
- add a `continue-review` command through the shared validator, runtime, hook,
  server API surface, and SPA controls
- keep review snapshots on the same REST/WS/RTC acceptance and repair paths as
  planning and finished snapshots
- disable scene planning input during review while keeping the Babylon scene
  mounted for reveal playback
- queue event animation cues so moves, searches, steals, damage, relic finds,
  collapse pressure, and finale cues can be watched in order
- add tests for shared-rule review transitions, app review summary/objective,
  snapshot phase ordering, and server API progression
- update current-state, UI/gameplay, runtime data-flow, scene contracts, visual
  direction, and scene upgrade plan docs

Exit criteria:

- all clients see a shared review state after a round resolves, the next turn
  starts only after review continuation, and finale presentation distinguishes
  escaping winners from hunters left in the collapsed castle

## Next Implementation Recommendation

Continue with the remaining Iteration 14 scene-boundary work before performance.

The playable loop now has a real two-browser convergence pass, while performance
work still assumes the scene and UI surfaces have stable visual baselines.
The next natural work is one more `RelicScene` boundary extraction, then
per-room picking support for cross-room instancing/shared geometry, then
production readiness.

## Concrete Next Tasks

1. Add review-phase browser coverage that verifies the review panel, disabled
   planning input, and `continue-review` transition.
2. Include the extra-wide side-panel scroll layout in the visual smoke checks.
3. Extract either event effects or player/relic sync out of `RelicScene.tsx`.
4. Keep the full-stack propagation spec available as a gated regression check
   whenever Rallar or room hydration changes.
5. Add a browser-level two-client avatar tracking assertion once the visual
   baseline pass has stable scene screenshots.
6. Add a two-client RTC snapshot-repair browser assertion that blocks or drops a
   WS update and verifies the stale client catches up from a peer snapshot.
7. Add a full-stack timeout-resolution propagation assertion that force-resolves
   an overdue round from one browser and verifies the other browser leaves the
   timed-out UI without manual refresh.
8. Add two-client review/finale propagation coverage once the gated full-stack
   harness can drive the explicit `continue-review` step.

## Open Questions

- Should future non-browser clients use the registered Rallar WS command topic,
  or should all gameplay command senders stay REST-first?
- Should peer snapshot repair remain full-snapshot based, or should it move to a
  smaller signed/hashed state digest once the playable loop is stable?
- Should disconnected players eventually be removable from the expedition
  roster, or should timer-based skip remain the only recovery path?
- Should the first playable camera be top-down/tactical instead of third-person roaming?
- Are real 3D assets planned, or should the procedural style be refined into an intentional low-poly direction?
- Should the intro cinematic stay in the first load path, or load only after the playable flow is stable?
