# Cash Chase Arena — Rallar-First Architecture and Renderer Plan

Updated: July 13, 2026

> The filename is retained for compatibility. React and Three.js are no longer treated as unexamined locked decisions; this document records the Rallar-first architecture and the measured renderer-selection gate.

## Document authority

This is the technical architecture source of truth for CCA. It implements the product outcomes in `Cash_Chase_Arena_Product_Owner_Document.md` and incorporates the evidence in `Cash_Chase_Arena_Complete_Review.md`.

`Cash_Chase_Arena_Engineering_Standards.md` defines deterministic numeric, code-shape, error, lifecycle, compatibility, diagnostics, tooling, dependency, and release rules. `Cash_Chase_Arena_Characters_Controls_Camera_Plan.md` may refine renderer-neutral presentation contracts but cannot change authority, dependency, networking, or package boundaries. `Cash_Chase_Arena_Implementation_Plan.md` defines execution order. The prompt pack must follow all of them.

## Architecture decisions

- Build `apps/cash-chase-arena` as the browser consumer.
- Build `packages/cash-chase-arena` as the pure reusable product/rules surface.
- Use Rallar as the only application communication platform.
- Compose current Rallar Rooms, Messages, Realtime, Game, Match, Motion, Data, AI, diagnostics, and shared-test APIs.
- Do not create CCA host-election, lease, lane-manager, message-bus, WebSocket, WebRTC, DataChannel, persistence, cross-tab-sync, CRDT, or AI lifecycle infrastructure.
- Use a browser director for the unranked MVP and preserve the current Rallar server-authority path for trusted production outcomes.
- Treat Rallar appointment epoch as the only authority epoch.
- Require generic Rallar Game migration orchestration before external peer-hosted MVP playtests.
- Keep simulation in pure TypeScript and move the authoritative tick into a dedicated worker before 3D load.
- Use Rallar Motion only in the presentation path.
- Use React/ReactDOM for low-frequency DOM UI, never the simulation or per-frame entity transforms.
- Put the 3D implementation behind a renderer-neutral adapter.
- Use direct Three.js as the leading renderer candidate, accepted only after an identical measured comparison with modular Babylon.
- Do not use React Three Fiber, Drei, postprocessing, Rapier, external state, networking, persistence, validation, or audio frameworks in MVP.
- Use native Web Audio and browser input/worker APIs.
- Keep AI and CRDT outside the core MVP critical path.
- Enforce the CCA engineering standards through checked-in format, lint, type-check, test, boundary, bundle, and browser commands.
- Complete a non-3D migration feasibility spike after the two-browser debug slice and before renderer investment; keep full hardening at the migration gate.

## Current Rallar fit

### Fully provided

Rallar currently provides:

- authentication, restored sessions, scoped rooms, membership, governance, invites, presence, and event replay;
- WS and RTC signaling, ICE/TURN configuration, readiness, health, diagnostics, reconnect, and ICE restart;
- typed room messages with RTC/WS strategies and fallback;
- room-scoped realtime JSON/binary lanes with explicit readiness and send results;
- Rallar Game lane presets and backpressure;
- host capability, deterministic host/backup election, director appointment policy, envelopes, epoch/sequence guards, status, diagnostics, sync, and browser match helpers;
- browser-director room-trusted results and server-authority server-validated results;
- Rallar Motion buffering, adaptive delay, interpolation, bounded dead reckoning, correction, discontinuity, kinematics, send gates, diagnostics, and quantization helpers;
- browser Rallar Data stores with validation, migrations, TTL, durability, hydration, IndexedDB, and cross-tab synchronization;
- Rallar CRDT authored documents and Rallar AI provider/schema/lifecycle/governance infrastructure;
- reusable black-box recipes, multi-browser providers, artifacts, diagnostics, and traffic/soak tooling.

### CCA composition work

CCA still owns:

- device capability readings and optional Rallar Game scoring weights;
- versioned game payloads and strict domain validators;
- deterministic match simulation, movement, collision, Sentinels, missions, score, catch, cash-out, and checkpoints;
- setup/start/recovery state machine around current Rallar Game operations;
- mapping accepted snapshots into Rallar Motion;
- UI, input, camera, rendering, audio, accessibility, content, and game-feel tuning;
- local Rallar Data store schemas and post-core AI proposal schemas/validators.

### Rallar gaps to close generically

1. **Browser-director migration:** Rallar has backup candidates, a replication lane, stale detection, recovery status, sync, and epoch guards, but not an end-to-end checkpoint/ack/promote/resume orchestrator.
2. **Director-centered RTC star:** current Rallar `star` connectivity is full peer connectivity. CCA initially accepts it for 2–8 players and measures. If it fails budgets, implement `director-star` in shared Rallar topology, not in the game.
3. **High-rate server authority:** current server authority is available and appropriate for trusted outcomes. If later requirements demand both server trust and RTC-rate snapshots, extend generic Rallar Authority rather than creating CCA transport.

## Dependency decisions

| Capability            | Decision                                                                             | Reason and gate                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| TypeScript/Vite       | Use existing workspace tooling.                                                      | No new runtime; established repository path.                                                                           |
| React/ReactDOM        | Use for lobby, HUD, menus, settings, errors, results, and semantic accessibility UI. | Rallar has no DOM renderer; native DOM would recreate lifecycle/form/focus infrastructure. No per-frame React state.   |
| Three.js              | Leading direct renderer candidate.                                                   | Smallest plausible scene/camera/material/GLB gap-filler. Lazy-load and measure before acceptance.                      |
| Babylon.js            | Bake-off comparator only.                                                            | Existing repository expertise may offset its broader observed runtime cost. Use identical scene and report total risk. |
| React Three Fiber     | Reject.                                                                              | Three does not require a second React renderer; imperative adapter keeps ownership clear.                              |
| Drei/postprocessing   | Reject for MVP.                                                                      | Convenience/effects are not capability gaps and threaten bundle/GPU budgets.                                           |
| Rapier/physics        | Reject for MVP.                                                                      | Deterministic capsule/bounds/obstacle/vault math is sufficient.                                                        |
| State framework       | Reject.                                                                              | Explicit runtime stores + React state + Rallar Data cover approved state classes.                                      |
| Network framework     | Reject.                                                                              | Rallar owns all application communication.                                                                             |
| Persistence framework | Reject.                                                                              | Rallar Data owns approved local persistence; CCA server persistence is out of scope.                                   |
| Audio framework       | Reject initially.                                                                    | Native Web Audio is sufficient and already demonstrated in AR Eye Hunter.                                              |
| Validation framework  | Reject initially.                                                                    | Pure type guards/domain validators keep the protocol small and testable.                                               |
| glTF Transform CLI    | Accept later as dev-only.                                                            | Offline asset optimization has no runtime cost and is needed only when GLBs become real.                               |
| Browser AI/WebLLM     | Reject from MVP critical bundle.                                                     | Production proposals run through Rallar Server and deterministic fallback.                                             |

## Repository shape

```text
apps/cash-chase-arena/
  package.json
  tsconfig.json
  vite.config.ts
  index.html
  src/
    main.tsx
    App.tsx
    rallar/
      cash-chase-rallar.ts
      cash-chase-protocol.ts
      cash-chase-migration.ts
      cash-chase-diagnostics.ts
    runtime/
      CashChaseRuntime.ts
      CashChaseWorkerBridge.ts
    worker/
      cash-chase-worker.ts
      worker-protocol.ts
    ui/
      Lobby.tsx
      GameHud.tsx
      Results.tsx
      Settings.tsx
      DiagnosticsOverlay.tsx
    renderer/
      CashChaseRenderer.ts
      ThreeCashChaseRenderer.ts
      renderer-bakeoff/
    audio/
      CashChaseAudio.ts
    styles.css
  tests/
  playwright.config.ts

packages/cash-chase-arena/
  mod.ts
  protocol.ts
  validation.ts
  config.ts
  state.ts
  simulation.ts
  movement.ts
  collision.ts
  sentinels.ts
  missions.ts
  scoring.ts
  arena.ts
  snapshots.ts
  migration.ts
  presentation.ts
  tsconfig.json

packages/tests/cash-chase-arena/
  protocol.test.ts
  simulation.test.ts
  determinism.test.ts
  movement.test.ts
  collision.test.ts
  sentinels.test.ts
  missions.test.ts
  scoring.test.ts
  arena.test.ts
  snapshots.test.ts
  migration.test.ts
```

The exact file set may be combined while modules are small, but boundaries must remain explicit. `packages/cash-chase-arena` never imports React, Three/Babylon, browser globals, or Rallar runtime code.

## Runtime architecture

### 1. `CashChaseSimulation`

Pure TypeScript state machine:

- fixed 30 Hz step;
- deterministic seeded random source with serializable state;
- ordered validated input application;
- movement, collision, stamina, dash, vault, interact;
- Sentinel patrol/chase/search/reset/tag;
- exactly three mission templates and non-overlapping scheduler;
- credit accrual, catch, cash-out, results;
- full snapshots and migration checkpoints;
- state hash for determinism tests.

The simulation accepts explicit time/tick and configuration. It does not read wall clock, DOM, network, storage, renderer objects, or AI. It follows the engineering deterministic contract: integer ticks, boundary quantization, stable ordering, serializable `xorshift32` state with defined zero normalization, canonical `fnv1a64-v1` hashing, and cross-engine parity fixtures.

### 2. `CashChaseWorkerBridge`

The main thread owns Rallar and presentation. The worker runs in one of two modes:

- `director`: authoritative simulation and checkpoint creation;
- `predictor`: bounded local runner prediction with no authority.

Messages are versioned, validated, and bounded. The bridge caps catch-up work after throttling/backgrounding and pauses rather than simulating an unbounded backlog. Every operation is generation-scoped; room switch, logout, unmount, replacement, or disposal aborts pending work and rejects stale completion.

### 3. `CashChaseRallarRuntime`

Compose the current public Rallar APIs:

- `rallar.rooms.createAndSwitch(...)` for a new private match room;
- `rallar.rooms.enter(...)` or `rooms.session(...)` for room-bound handles;
- `createRallarBrowserMatch(...)` / its underlying Rallar Game handle for match transport, diagnostics, election, appointment, input, intents, snapshots, events, and sync;
- `rallar.messages.room<T>(...)` for versioned lobby/setup/ready/recovery commits with RTC/WS fallback;
- `rallar.realtime.room<T>(...)` only where the Rallar Game handle does not already expose the required generic behavior;
- `RallarMotion` for accepted snapshot presentation;
- `rallar.data` for approved local stores.

Do not wire `rtc.waitForRoomLane`, `readyPeerIds`, or `realtime.sendJson` manually when Rallar Game or a room handle already represents the operation.

### 4. `CashChaseMotionPresenter`

For each received entity:

1. accept only a Rallar Game envelope that passed protocol/room/match/director/sequence checks;
2. use receiver-local `receivedAt/observedAtEpochMs` for sample time;
3. retain sender time, director tick, and snapshot revision only as metadata;
4. push position, rotation, optional velocity, and discontinuity metadata into Rallar Motion;
5. sample render poses per frame;
6. blend small local prediction errors and snap large/recovery discontinuities;
7. remove tracks when entities leave or the match/epoch changes.

Initial Motion tuning remains configuration and must be measured:

```text
interpolation delay: 100–140 ms adaptive range baseline
max extrapolation: 120–200 ms
interpolation: Hermite with reliable velocity, linear otherwise
yaw wrap: 2 * Math.PI
large correction: snap and emit bounded diagnostic
```

### 5. `CashChaseRenderer`

Renderer-neutral interface:

```ts
export interface CashChaseRenderer {
    mount(canvas: HTMLCanvasElement): Promise<void>;
    loadArena(arena: ArenaLayout): Promise<void>;
    render(frame: CashChasePresentationFrame): void;
    resize(width: number, height: number, pixelRatio: number): void;
    diagnostics(): CashChaseRendererDiagnostics;
    dispose(): Promise<void>;
}
```

The renderer owns scene/camera/meshes/materials/animation/effects and no game rules. React mounts the canvas and reads low-frequency diagnostics; it does not represent every scene entity as a component.

## Protocol design

### Identity and ordering

Rallar Game envelope fields are the transport source of truth:

```text
protocol
kind
roomId
matchId
senderId
seq
sentAtEpochMs
directorEpoch
```

CCA payloads must not duplicate a trusted `playerId`, transport sequence, sender timestamp, or authority epoch. The director maps `envelope.senderId` to the match participant.

### Input payload

```ts
type CashChaseInput = Readonly<{
    version: 1;
    clientTick: number;
    moveX: number;
    moveY: number;
    cameraYaw: number;
    sprintHeld: boolean;
    dashPressed: boolean;
    vaultPressed: boolean;
    interactPressed: boolean;
}>;
```

Inputs are clamped and normalized. Edge-triggered actions are consumed once and never repeated when packets are missing. Rallar Game input flow uses latest-by-sender semantics and a short maximum age.

### Reliable intents and commits

Reliable messages include:

- ready/capability-related app state not already represented by Rallar Game;
- `SetupCommit` and `SetupReady`;
- match start/cancel;
- cash-out/mission interaction intent when reliable handling is required;
- critical game event;
- sync request/full repair;
- migration checkpoint acknowledgement, recovery commit, and interrupted-round outcome.

Each message has protocol version, match ID, type discriminator, bounded payload, and strict validator. Use Rallar Game intent/event/sync paths where the generic handle already fits; use typed room messages only for setup/lobby/recovery messages outside that handle.

### Version compatibility

- `SetupCommit` pins protocol, simulation, content-manifest, hash, and client-build compatibility for the round.
- Unsupported major versions are rejected before ready with an actionable refresh/incompatibility status.
- Optional additive fields are compatible only when validators define their absent default explicitly.
- Unsupported checkpoint versions terminate recovery without a result; they are never coerced into current state.
- Deployment is hard-cut unless the previous client version has explicit compatibility fixtures. Old cached clients cannot ready into a newer hard-cut room.
- Payload validators reject forbidden identity/order fields, unknown discriminators, non-finite values, and excess fields that could conceal trusted data.

### Snapshot payload

Start with compact full snapshots. Each snapshot contains:

```text
tick
phase
remainingTicks
stateRevision
players: compact authoritative state + cosmeticPresetId
sentinels: compact authoritative state
mission: current public mission state
objects: only dynamic public state
score rows
```

The Rallar envelope supplies sequence, send time, match, sender, and epoch. Measure serialization, allocation, payload size, and host fanout before considering binary or delta snapshots.

### Migration checkpoint

```text
version
protocolVersion
matchId
tick
stateRevision
directorEpoch
seed and RNG state
full authoritative simulation state
last accepted input sequence per sender
critical event revision
createdAtEpochMs
state hash
```

Checkpoint acceptance validates protocol/match/epoch/revision/hash and acknowledges the latest accepted tick. CCA defines the schema/restore hooks; generic send/ack/promotion orchestration belongs in Rallar Game.

## Networking and topology

- High-rate input targets only the fresh director through Rallar Game.
- Snapshots use the Rallar Game room realtime path with latest-value flow control.
- Reliable intents/events/sync use Director Relay or typed room fallback as provided by Rallar Game.
- Do not name the connectivity graph a physical super-peer star. Current Rallar small-room connectivity may be full peer connectivity while authority traffic is director-routed.
- Measure 2, 4, and 8 peers, direct and TURN, before adding topology work.
- If full connectivity breaches setup, CPU, memory, or bandwidth budgets, add a shared Rallar `director-star` topology bound to the fresh appointment and tested across migration.

## Early migration feasibility gate

Before renderer work, the debug two-browser slice must prove the generic shape without depending on 3D:

1. director publishes an opaque versioned checkpoint to the elected backup;
2. backup validates and acknowledges tick, revision, and hash;
3. stale director pauses accepted outcomes;
4. one higher epoch appoints and invokes a promotion/restore callback;
5. old-epoch inputs, snapshots, events, recovery commits, and results are rejected;
6. success resumes at a shared future tick and failure aborts within 10 seconds without a result.

This spike may remain behind internal/test-only interfaces until the public API review at Gate 6. It must use current Rallar election, appointment, lanes, envelopes, status, and diagnostics rather than introducing a CCA transport or lease.

## Match lifecycle

### Lobby → setup → active

1. Restore/start Rallar and enter scoped room.
2. Observe members/presence; enforce one active seat per scoped participant and collect ready/capability state.
3. Rallar Game elects host/backup; elected eligible session appoints.
4. Director immediately selects deterministic arena/deck; optional post-core AI may race under a deadline.
5. Send reliable `SetupCommit`; clients validate/build and reply `SetupReady`.
6. Wait for configured member and lane expectations.
7. Send reliable start tick; director worker begins authoritative step.

### Reconnect and late join

- Pause local authority-dependent actions when the director is stale.
- Request reliable setup/current-state sync after reconnect or late join.
- Validate commit and full snapshot before entering active presentation.
- Clear old Motion tracks/prediction when match or authority epoch changes.
- Late joiners enter as spectators until the next readiness cycle. Every active runner receives the product's 10-second gameplay reconnect grace; director loss independently triggers authority migration, and a returning former director syncs to the current epoch. Grace expiry or voluntary leave loses unbanked credits and cannot re-enter active play that round.
- Director/backup eligibility follows Rallar capability and freshness even when that participant's runner is caught or cashed out.

### Migration

1. Director publishes versioned checkpoints to elected backup and after critical events.
2. Backup validates and acknowledges latest tick/revision.
3. Stale appointment pauses all peers.
4. Rallar Game deterministically re-elects and appoints one higher epoch.
5. Replacement restores latest acknowledged checkpoint.
6. Replacement sends recovery commit/full snapshot and resumes at shared future tick.
7. Old epochs are rejected; failure after 10 seconds interrupts the round without a result.

## Rallar Data stores

Use stable validated definitions:

```text
cca-settings             principal, write-through, versioned migration
cca-loadout-selection    principal, write-through, known preset validation
cca-room-recents         principal, write-behind, bounded entries
cca-debug-log            session, write-behind, TTL and size cap
```

An optional local AI replay store may be added with the post-core AI feature. Do not open server Rallar Data for CCA match/game data.

## AI and CRDT placement

### Rallar AI

Post-core server flow:

1. Build strict CCA proposal schema and deterministic validator.
2. Request through `createRallarServerAi` with server-only credentials and limits.
3. Reject malformed, domain-invalid, stale, duplicate, unauthorized, timed-out, or unavailable output.
4. Accept once through Rallar AI lifecycle/dedupe helpers.
5. Commit accepted content through normal validated setup flow.
6. Never persist CCA proposal/content catalogs server-side in MVP; deterministic package content remains fallback.

### Rallar CRDT

No MVP CRDT code. A later approved creator/review feature may open a room-scoped authored document and must convert accepted authored content into one validated setup commit before it affects a round.

## Renderer selection gate

Build the same representative scene twice behind `CashChaseRenderer`:

```text
8 runners
6 Sentinels
40 obstacles
terminals, gates, reward zone, cash-out stations
third-person camera and obstruction test
Rallar Motion-fed transforms
basic emissive/readable materials
resource disposal and diagnostics
```

Report for direct Three and modular Babylon:

- dependency graph and lockfile change;
- minified/gzip/Brotli renderer chunk;
- cold setup-to-first-frame;
- p50/p95 frame time on reference and throttled desktop;
- heap and exposed GPU/draw-call/resource metrics;
- camera/asset ergonomics and lifecycle complexity;
- 20 mount/load/dispose cycles without retained growth.

Choose the lower total-risk option that meets product budgets. The default hypothesis is direct Three. R3F/Drei are not part of the comparison unless a separate measured requirement justifies them.

## Performance and lifecycle rules

- Lobby route must not import renderer, GLB assets, postprocessing, or AI provider code.
- No per-frame React state update.
- Cap simulation catch-up, entity/debug arrays, queues, audio voices, Motion samples, and local logs.
- Prefer compact structures/maps for entity lookup; avoid repeated full scans on tick hot paths after workload proves them costly.
- Every Rallar subscription, timer, worker, audio node/context, renderer resource, scene object, and Motion track has one explicit disposer owner.
- `start`, join, setup, renderer load, and recovery accept cancellation or a generation token; stale asynchronous work cannot mutate a replaced runtime.
- `stop` and `dispose` are idempotent after partial initialization and release resources in reverse ownership order.
- WebGL context loss pauses/rebuilds presentation without changing simulation truth; audio interruption never blocks play.
- Record static concerns as hypotheses; optimize only after profile/benchmark evidence.
- Generated profiles live in `tmp/perf/` and are not committed.

## Error and diagnostic architecture

- Expected failures return typed results using the stable CCA error families in the engineering standards; exceptions are reserved for invariant/programmer errors and are contained by the app error boundary.
- Every failure records bounded operator context and a separate user-safe message. Secrets, SDP/ICE details, full payloads, provider prompts, and stack traces are never user-visible.
- Runtime diagnostics correlate room reference, match, participant, director epoch, tick, build, and stable event/error code where available.
- Normal operation uses capped counters/histograms rather than per-input or per-frame logs.
- No failure is silently swallowed: it transitions state, returns a result, performs a bounded retry, or emits a capped diagnostic.

## Security and trust

- All gameplay mutations validate sender-derived identity, phase, bounds, rate, cooldown, and proximity.
- Never accept client-reported outcome, score, catch, cash-out, or Sentinel truth.
- Browser-director results are displayed as room-trusted and remain ephemeral/unranked.
- Trusted rewards or durable results require current Rallar server authority.
- Provider/TURN credentials stay server-side; generated/player text is escaped; payloads and prompts are bounded.
- Apply explicit CSP/allowed origins and review direct/transitive licenses, vulnerabilities, and asset provenance before release.

## Validation obligations

### Pure CCA

- Unit/property tests for protocol validators, determinism, movement, collision, Sentinels, all three missions, score/catch/cash-out, arena validation, snapshots, checkpoints, and cosmetics.
- Node/browser-worker state-hash parity.
- Representative simulation benchmark before renderer integration.

### Rallar integration

- Existing Rallar Game, Motion, room realtime/message, Data, AI, and authority tests.
- CCA adapter tests for public API composition, lifecycle cleanup, wrong scope/match/epoch/sequence, setup, sync, and diagnostics.
- Shared-web public API snapshots and bundle-boundary checks for generic migration/topology work.
- Build AR Eye Hunter and Relic Hunters after shared game/realtime changes.

### Browser and black box

- Visible create/join/ready/start/play/mission/cash-out/results/rematch flows.
- 2/4/8 contexts, direct/TURN, partial readiness, reconnect, late join, director loss, old director return.
- Chromium/Firefox/WebKit CI where practical and manual Safari/TURN validation.
- Bundle, cold-load, frame, simulation, payload/bandwidth, memory, and 20-round soak gates.

## Public CCA concepts

`packages/cash-chase-arena` should expose renderer- and transport-neutral concepts only:

```text
CashChaseProtocolVersion
CashChaseSimulationVersion
CashChaseContentManifestVersion
CashChaseHashVersion
CashChaseCompatibility
CashChaseOperationalError
CashChaseConfig
CashChaseInput
CashChaseState
CashChaseSnapshot
CashChaseMigrationCheckpoint
CashChaseReliableMessage
ArenaLayout
MissionCard
MissionState
PlayerState
SentinelState
GameplayCapsule
CosmeticPresetId
CharacterPresentationState
createInitialCashChaseState
stepCashChase
applyCashChaseInput
validateCashChaseInput
validateArenaLayout
createFallbackArena
buildCashChaseSnapshot
createMigrationCheckpoint
restoreMigrationCheckpoint
hashCashChaseState
derivePresentationFrame
```

Do not export Rallar facades, React components, Three/Babylon types, browser objects, or provider-specific AI types from this package.
