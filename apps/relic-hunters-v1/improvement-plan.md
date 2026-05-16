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
stability over new visual content. Auth/lobby now use a static backdrop instead
of mounting the full Babylon runtime, the planning scene uses a capped render
loop with lighter shadows/SSAO/bloom, and the scene paints an early frame so
canvas readiness checks do not race heavy setup. Blocking intro/onboarding flows
are disabled by default while the playable loop is stabilized. Shared gameplay
rules were also tightened: Entrance no longer contains a hidden relic, relic
discoveries immediately create durable room investigations, and route hints
prefer higher-value adjacent relic leads. The second pass disables
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

Deliverables:

- replace many competing feedback overlays with one event timeline and one current-turn summary
- group events by round
- distinguish "your action", "party action", "castle reaction", and "result"
- make new events visible without blocking controls for too long

Exit criteria:

- players understand what happened after every round

### Iteration 11: Tests And Playwright Coverage

Add automated coverage around the real gameplay loop.

Deliverables:

- unit tests for view model
- unit tests for action legality and turn summaries
- browser tests for login/register, room create/join, join expedition, start, submit, wait, resolve
- layout screenshot tests for core viewports
- Rallar runtime tests with fake Rallar facade where possible

Exit criteria:

- future UI and Rallar changes do not regress the basic playable loop

### Iteration 12: Performance And Production Readiness

Harden the app after the core loop is readable.

Deliverables:

- code-split intro scene and game scene
- lazy-load Babylon-heavy modules
- add frame-time diagnostics in development mode
- add fallback rendering for weak devices
- add error boundaries around scene runtime
- document deployment configuration for API base URL and server pairing

Exit criteria:

- production build size and runtime performance are understood and acceptable

## First Implementation Recommendation

Start with Iteration 2 and Iteration 4, not graphics.

The visual quality will remain hard to judge while the screen is crowded and while connection/game states are ambiguous. A stable HUD shell plus a Rallar/game runtime facade will make every later improvement safer.

## Concrete First Tasks

1. Extract `useRelicHunters` internals into a runtime module with explicit connection phases.
2. Add `GameHud` and move only the topbar, side panel, and bottom panel into it.
3. Remove or temporarily disable duplicate overlays that occupy bottom-center and left-bottom screen space.
4. Add a development-only Rallar status panel showing auth, connect status, current room, snapshot age, WS listener state, and RTC position status.
5. Capture before/after screenshots at 1440x900, 1024x768, and 390x844.

## Open Questions

- Should future non-browser clients use the registered Rallar WS command topic,
  or should all gameplay command senders stay REST-first?
- Should RTC position sharing be gameplay-relevant or only cosmetic?
- Should disconnected players block turn resolution?
- Should the first playable camera be top-down/tactical instead of third-person roaming?
- Are real 3D assets planned, or should the procedural style be refined into an intentional low-poly direction?
- Should the intro cinematic stay in the first load path, or load only after the playable flow is stable?
