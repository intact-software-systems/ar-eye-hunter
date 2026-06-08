# Cash Chase Arena (CCA) — Codex Prompt Pack

Prepared: May 22, 2026

## How to use this prompt pack

- Use one prompt at a time.
- Review diffs and run validation before continuing.
- Keep the product and implementation documents in the repo.
- Keep secrets server-side only.

## Global context to paste before any prompt

```text
Project context:
Cash Chase Arena (CCA) is a browser-native multiplayer chase game. It uses Rallar as the only communication middleware. The MVP uses a browser-director model: one automatically elected browser acts as temporary match host through Rallar Game/Rallar director primitives, while Rallar Server handles bootstrap, rooms, signaling, ICE config, ephemeral Rallar AI content proposals, and recovery coordination. After match handoff, high-rate gameplay traffic uses Rallar realtime lanes. The MVP uses React, React Three Fiber, Three.js, host-owned deterministic simulation, a fixed gameplay capsule for every runner, Rallar Motion for snapshot presentation smoothing, browser-local Rallar Data for preferences/local caches/debug artifacts, no real money, original IP, and Rallar AI-generated candidate layouts and mission decks validated by deterministic code. Rallar CRDT is optional for lobby, creator, AI-review, or playtest-note documents after MVP, or local-only during MVP; it is not live match authority.

Engineering rules:
- Keep Rallar AI provider credentials and TURN secrets server-side only.
- Do not persist app-owned CCA match or game data server-side in MVP; server persistence is limited to generic Rallar Server infrastructure data.
- Prefer small, testable modules.
- Add or update tests for new logic.
- Run typecheck and targeted tests after changes.
- Do not implement full anti-cheat yet; prioritize match consistency.
- Do not create raw WebSocket, RTCPeerConnection, or DataChannel objects in CCA game code; compose Rallar.
- Characters are identities, not classes: cosmetics may not change collision, movement, Sentinel visibility, scoring, or interaction rules.
- Character animation follows simulation state; do not use root motion for authoritative movement.
- Ship character visuals in stages: neon capsules, modular mannequin, shared rig, then GLB/glTF assets.
- Use browser-local Rallar Data for latest-value settings, selected loadout, local AI replay, room recents, and debug artifacts only.
- Do not use Rallar Data for live inputs, snapshots, scores, Sentinel state, host election, recovery leases, collaboration documents, or server-side CCA game-data caches.
- Use Rallar Motion for render-pose smoothing, not for simulation, scoring, collision, or authority.
- Use Rallar CRDT only for collaborative authored documents outside the active match loop.
- Avoid direct references to existing TV show names, characters, costumes, or branded presentation.
- Treat Rallar AI output as proposals; CCA validators own final acceptance.
```

## 0. Repository Orientation and Build Strategy

**Goal:** Have Codex inspect the repo or create a build plan before editing.

```text
You are working on Cash Chase Arena, a browser-native WebRTC-first multiplayer chase game. Before writing code, inspect the repository structure, package manager files, TypeScript config, and any existing docs. Summarize what exists, identify missing foundations, and propose a minimal implementation order. Do not make code changes yet unless the repo is empty and you need to create a README placeholder. End with the exact commands you recommend running for install, typecheck, tests, and local development.
```

## 1. Monorepo Scaffold

**Goal:** Create the basic project structure.

```text
Create the CCA project structure inside the existing monorepo. Add apps/cash-chase-arena for a Vite React browser client and packages/cash-chase-core for plain TypeScript simulation/protocol code. Compose the existing Rallar browser/server packages instead of creating a custom netcode package. Add or update scripts for dev, build, typecheck, and test using the repo's package manager. Keep the first implementation minimal: no 3D scene yet, just a page that can initialize Rallar and show session/room status. Add README instructions. After changes, run install only if needed, then run typecheck and build. Report any failures and fixes.
```

## 2. Shared Schemas and Protocol Types

**Goal:** Define the authoritative shared data model.

```text
In packages/cash-chase-core, implement schemas or narrow validation helpers and inferred TypeScript types for PlayerId, MatchId, HostCapability, HostLease, GameplayCapsule, CharacterCosmeticLoadout, VisualCharacterPreset, CharacterAnimationState, CharacterAssetManifest, PlayerControlInput, DirectorSnapshot, PlayerState, SentinelState, MissionCard, MissionState, ArenaLayout, ReliableGameEvent, HostMigrationState, CashChaseMotionSampleMetadata, browser-local CCA Rallar Data store IDs, and optional CCA CRDT document type IDs. Include constants for arena bounds, match tick rate, snapshot rate, Rallar lane IDs, Rallar type IDs, browser-local Rallar Data store names/schema versions, and protocol version. Add unit tests for validation, including invalid coordinates, missing IDs, bad mission templates, cosmetic stat invariants, gameplay capsule invariants, animation-state mapping, asset manifest validation, persisted loadout selection validation, Rallar Data store option validation, and snapshot-to-motion-sample conversion. Export everything from a package index. Run typecheck and tests.
```

## 3. Rallar Room And Signaling Integration

**Goal:** Build the minimal CCA room coordinator on top of Rallar.

```text
In apps/cash-chase-arena, compose the existing Rallar browser facade and the existing Rallar Server/API rather than creating a CCA-specific WebSocket lobby. Support create room, join room, leave room, ready state, capability report, and room-scoped match status through Rallar rooms/messages. It must not run the game simulation on the server. Add validation for CCA messages using packages/cash-chase-core helpers. Add tests or mocked adapter coverage for room lifecycle mapping and signaling readiness. Run typecheck and tests.
```

## 4. Host Election and Host Lease

**Goal:** Select one browser as the match host.

```text
Add host election through Rallar Game/browser-director helpers, not a CCA-specific backend match service. When all lobby players are ready or the lobby leader clicks start, score HostCapability reports using RTT, FPS, hardwareConcurrency, deviceMemory, mobile penalty, battery-saver penalty, and previous disconnect penalty. Derive or relay a HostLease containing matchId, hostPeerId, backupPeerId, hostEpoch, and expiresAt through Rallar room/director messages. Keep the lease transient and do not persist it as server-side CCA match data. Add tests for scoring, deterministic tie-breaks, mobile penalty, missing capability fallback, and backup host selection. Run typecheck and tests.
```

## 5. Web Client Lobby Shell

**Goal:** Create the browser lobby UI and backend connection.

```text
In apps/cash-chase-arena, build a minimal React lobby UI: create/join room, display room code, list players, mark ready, show selected director/backup in a debug panel, and show Rallar connection state. Connect through the Rallar browser facade. Send a HostCapability report based on measured signal RTT, approximate FPS sample, navigator.hardwareConcurrency, navigator.deviceMemory if available, and mobile detection. Keep UI simple and functional. Run typecheck and build.
```

## 6. Rallar Connection And Lane Readiness

**Goal:** Establish Rallar room, director, and realtime lane readiness.

```text
In apps/cash-chase-arena, compose the existing Rallar browser facade. Start Rallar with CCA/Rallar Game lane presets, create or join a room, observe room members, report host capability, elect or observe the browser director, and wait for input/snapshot lane readiness. Do not create raw WebSocket, RTCPeerConnection, or DataChannel objects. Add connection state tracking and debug output for room, director, RTC status, and lane readiness. Do not implement gameplay yet. Run typecheck and build.
```

## 7. Rallar Game Lane Routing And Backpressure

**Goal:** Create the CCA Rallar lane protocol.

```text
Define CCA lane IDs by composing Rallar Game lane presets: input, intent, snapshot, metrics, and replication. Configure input/snapshot as unordered low-latency lanes and reliable traffic through Director Relay or the appropriate reliable lane. Add thin CCA helpers that call Rallar Game/Rallar realtime send APIs, check lane readiness/health, and expose backpressure diagnostics. Do not add a custom channel manager. Add tests for lane IDs, type IDs, helper behavior, and degraded-state reporting. Run typecheck and build.
```

## 8. Browser Host Runtime Skeleton

**Goal:** Make the elected host act as the match server.

```text
In packages/cash-chase-core, implement BrowserDirectorRuntime/GameSimulation with a fixed tick loop, input queue, player state map, match phase, tick counter, and snapshot builder. In apps/cash-chase-arena, instantiate the runtime only on the elected browser director. Non-director clients send PlayerControlInput through the Rallar input lane at 20-30Hz. The director broadcasts DirectorSnapshot through the Rallar snapshot lane at 10-20Hz. For now, represent players as 2D positions and apply simple movement. Add deterministic unit tests for movement update, input sequence handling, and snapshot creation. Run typecheck, tests, and build.
```

## 9. Rallar Motion Snapshot Presentation

**Goal:** Render director state smoothly in clients.

```text
In apps/cash-chase-arena, implement a GameClientRuntime/RallarMatchRuntime that sends PlayerControlInput to the browser director, receives accepted DirectorSnapshot messages, converts entity poses into Rallar Motion samples, and exposes sampled render poses to the scene. Use Rallar Motion adaptive delay, interpolation, short-gap extrapolation, correction blending for local prediction, and discontinuity handling for dash, respawn, caught, cash-out, spectator, and recovery transitions. Render a simple debug view first showing player dots, director tick, snapshot age, estimate mode, confidence, and missed snapshots. Include local input capture for WASD, mouse yaw, sprint, dash, vault, and interact. Run typecheck and build.
```

## 9B. Rallar Data Preferences And Debug Stores

**Goal:** Persist local latest-value state without moving match authority into storage.

```text
After the first Rallar vertical slice works, add browser-local CCA Rallar Data stores for settings, loadout selection, room recents, local AI replay, and bounded debug logs. Use browser rallar.data with stable store names, schemaVersion, validation, and migrations where needed. Suggested stores: cca-settings with principal scope and write-through durability; cca-loadout-selection with principal scope and write-through durability; cca-room-recents with principal scope and write-behind durability; cca-ai-replay with session or principal scope, write-behind durability, and bounded TTL; cca-debug-log with session scope, write-behind durability, and bounded TTL. Do not store live inputs, director snapshots, scores, Sentinel state, host election, recovery leases, collaborative documents, or any app-owned CCA match/game data on the server. Add tests for open/hydrate/read/write/update/flush, invalid value rejection, schema migration, TTL expiry, proof that match authority code does not read these stores during simulation, and review checks proving no server rallar.data.open calls are introduced for CCA match/game data in MVP. Run typecheck and tests.
```

## 10. Procedural Arena Layout and Validator

**Goal:** Create deterministic maps before AI.

```text
In packages/cash-chase-core, implement ArenaLayout types if not already present, a fallback map generator, and a LayoutValidator. Validate coordinate bounds, spawn zone clearance, obstacle count, object IDs, cash-out station count, mission terminal count, sentinel spawn count, and simple obstacle overlap. Add at least three fallback layouts with different cover patterns. Add unit tests for valid maps and rejected invalid maps. Wire the CCA match setup flow to send a validated fallback map as MAP_COMMIT before match start through Rallar messages or Rallar Game startup flow. Run typecheck and tests.
```

## 11. React Three Fiber Procedural Renderer

**Goal:** Move from debug view to 3D scene.

```text
Add Three.js, React Three Fiber, and Drei to apps/cash-chase-arena if they are not already present. Build the arena from ArenaLayout: floor, boundary walls, obstacles, cash-out stations, terminals, Sentinel gates, player capsules, and Sentinel capsules. Keep materials simple and readable. Do not require WebGPU or external assets. Connect Rallar Motion render estimates, not raw snapshots, to rendered remote entity positions. Add a debug overlay that can show the fixed gameplay capsule separately from the visual runner. Run typecheck and build.
```

## 11B. Character Vertical Slice

**Goal:** Prove character readability before polished assets.

```text
In apps/cash-chase-arena and packages/cash-chase-core, implement the CCA character vertical slice. Add a fixed GameplayCapsule used by every runner, three simple R3F visual silhouettes, six accent colors, and a debug overlay that displays capsule versus visual mesh alignment. Add a CharacterCosmeticLoadout and VisualCharacterPreset mapping that cannot change gameplay constants. Persist only the local selected loadout ID through Rallar Data and validate it against known presets before use. Add presentation-only animation state mapping for idle, jog, sprint, dash, vault placeholder, interact, caught, cash-out, and spectator idle. Add a dash trail and vault placeholder effect driven by simulation state. Do not add root motion, mesh-derived collision, character stats, abilities, or a heavy GLB pipeline yet. Add tests for capsule invariants, cosmetic stat invariants, persisted loadout selection validation, animation-state mapping, and preset validation. Run typecheck and tests.
```

## 11C. Character GLB Asset Pipeline

**Goal:** Move from mannequin visuals to shippable character assets after the vertical slice works.

```text
After the character vertical slice is playable and readable, add the first GLB/glTF character asset pipeline. Define a CharacterAssetManifest with stable mesh, bone, material, animation clip, and attachment names. Use one shared scale, one forward axis, one shared rig, consistent pivots, reusable materials, and modular attachment points for headgear, torso, legs, accent color, and trail FX. Validate imported assets against the fixed gameplay capsule and camera distance. Do not derive collision from the mesh. Add lightweight runtime validation and a browser visual QA checklist for scale, orientation, material budget, animation mapping, and capsule alignment. Run typecheck and build.
```

## 12. Sentinel AI

**Goal:** Add the core chase threat.

```text
In packages/cash-chase-core, implement director-owned Sentinel AI. Sentinels should have states PATROL, CHASE, SEARCH, and RESET. Use simple waypoint patrols from the ArenaLayout, distance-based detection, line-of-sight approximation using obstacle blockers if feasible, chase movement with max speed, and tag radius. The browser director decides eliminations and sends ReliableGameEvent messages through Rallar Game/Director Relay. Add unit tests for detection, chase, tag, and reset behavior. Run typecheck and tests.
```

## 13. Scoring and Cash-Out

**Goal:** Make the game loop meaningful.

```text
Implement score accumulation in BrowserDirectorRuntime/GameSimulation: +10 credits per second alive, banked score, unbanked score, caught behavior, survival bonus, and match end scoreboard. Add CashOutStation interaction: clients send interaction intent, the browser director validates proximity and active phase, then banks score and changes player state to CASHED_OUT or SPECTATOR. Add UI for current score, banked score, and final scoreboard. Add unit tests for score and cash-out rules. Run typecheck, tests, and build.
```

## 14. Mission Deck and Mission Scheduler

**Goal:** Prevent passive hiding and add strategy.

```text
Implement mission templates DISABLE_SENTINEL_GATE, OPEN_CASHOUT_WINDOW, DOUBLE_REWARD_ZONE, RESCUE_CAPTURED_PLAYER, and FORCED_MOVEMENT_ALARM. Create a MissionScheduler that selects eligible mission cards based on match time and state. Host validates terminal interactions and applies mission success/failure effects. Add mission alert UI with objective, countdown, reward, and failure consequence. Add unit tests for mission eligibility, completion, timeout, and effects. Run typecheck, tests, and build.
```

## 15. Rallar AI Layout, Mission, And Cosmetic Proposals

**Goal:** Add Rallar AI-assisted variety safely.

```text
Add an ephemeral server-side Rallar AI generation flow for CCA arena layout, mission deck, and cosmetic preset proposals. Keep provider credentials server-side only and never expose them to the client. Use strict schemas for candidate ArenaLayout, MissionDeck, and cosmetic preset proposal types, stable schema IDs, dedupe keys, and Rallar AI lifecycle states. Sanitize theme input. After generation, run LayoutValidator, mission template validation, and cosmetic-only validation. Accept each valid proposal once before committing it through match setup; if validation fails, generation is stale, the provider times out, or the provider is unavailable, use fallback layout, mission deck, and curated cosmetic presets. Do not persist generated, accepted, rejected, fallback, or summary CCA game content as server app data in MVP. Add tests with a mock Rallar AI provider for valid output, schema-invalid output, domain-invalid output, stale output, duplicate dedupe key, provider failure, and proof that no server-side CCA AI proposal cache is written. Run typecheck and tests.
```

## 15B. Optional Rallar CRDT AI Review Or Creator Documents

**Goal:** Add collaborative authored-state documents without moving match authority into CRDT.

```text
After the playable loop and Rallar AI proposal flow are stable, add an optional Rallar CRDT document for one concrete use case: AI proposal review, lobby planning, arena drafts, mission deck drafts, or playtest notes. For MVP, keep CRDT documents local-only/non-server-persisted or defer them until post-MVP. Use document types such as cca-ai-review or cca-arena-draft. Do not store player positions, live snapshots, Sentinel state, scoring, caught state, cash-out, mission completion, host election, recovery state, inventory, anti-cheat state, or server-durable CCA match/game data in CRDT. Accepted CRDT-authored content must be committed once through normal CCA match setup before a round starts. Add tests or mocked integration coverage for open/apply/subscribe, validation before commit, no server-side persistence in MVP, and CRDT health diagnostics. Run typecheck and tests.
```

## 16. Match Start Handoff Flow

**Goal:** Connect lobby, AI/fallback map, Rallar lanes, and runtime.

```text
Implement the full match start workflow. Host clicks Start. Rallar room state and Rallar Game/director helpers elect or observe host and backup, obtain a validated map and mission deck, broadcast or relay MAP_COMMIT, wait for Rallar lane readiness and client ready acknowledgements, then enter the active phase. After handoff, gameplay traffic should use Rallar realtime lanes and Director Relay. Add status UI for each phase: electing host, generating map, connecting peers, building arena, ready, active. Add integration tests or a manual smoke-test script. Run typecheck, tests, and build.
```

## 17. Backup Host Replication and Migration

**Goal:** Recover from browser director disconnects.

```text
Implement browser director replication to the backup candidate over the Rallar replication lane or reliable Rallar Game path. Replicate HostMigrationState once per second and after critical reliable events. Detect director failure via missed snapshots, stale director heartbeat, and Rallar status changes. Trigger Rallar Game recovery: pause, re-elect, increment hostEpoch, request sync, and broadcast a recovery snapshot. Add debug controls to simulate director disconnect. Add tests for migration state serialization, epoch rejection, stale director handling, and recovery snapshot acceptance. Run typecheck, tests, and build.
```

## 18. Transport Metrics and Debug Overlay

**Goal:** Make networking observable.

```text
Add a debug overlay showing playerId, roomId, matchId, directorPeerId, backupPeerId, whether this browser is director, hostEpoch, Rallar room state, RTC status, Rallar lane states, ping estimate, snapshot rate, missed snapshots, buffered amount/queue diagnostics where exposed by Rallar, Rallar Motion estimate mode/confidence/interpolation delay, current tick, FPS, selected graphics tier, and CRDT health only when an optional CRDT document is open. Add a metrics lane message exchanged every few seconds. Ensure overlay can be toggled and is hidden by default. Run typecheck and build.
```

## 19. Playtest Hardening

**Goal:** Prepare for first external test.

```text
Harden the MVP for a 2-8 player playtest. Add clear error states for failed Rallar connection, missing TURN config, director migration failure, Rallar AI generation failure, optional CRDT document failure, and browser unsupported features. Add a simple onboarding panel explaining peer-hosted Rallar/WebRTC matches. Add a fallback to procedural WebGL. Add a manual QA checklist in docs/playtest-checklist.md. Run typecheck, tests, build, and a local smoke test if possible.
```

## 20. Deployment Preparation

**Goal:** Make the app deployable.

```text
Prepare staging deployment. Add environment variable documentation for backend port, allowed origins, Rallar AI provider configuration, AI model name, ICE servers, TURN username/credential, and logging mode. Add Dockerfile or deployment notes for the backend and static hosting notes for the client. Ensure HTTPS/WSS assumptions are documented. Add health checks. Make sure no secrets are committed. Run typecheck, tests, and build.
```

## 21. Focused Code Review Prompt

**Goal:** Use Codex to review after each milestone.

```text
Review the most recent implementation for Cash Chase Arena. Focus on correctness, missed edge cases, TypeScript type safety, resource cleanup, Rallar lifecycle bugs, Rallar lane/backpressure handling, Rallar Motion smoothing or correction mistakes, accidental CRDT use in live match authority, and mismatch with the product/implementation docs. Do not rewrite large areas unless necessary. Produce a prioritized issue list, then fix only the top critical issues. Run the most relevant validation commands and report results.
```

## 22. Bug-Fix Prompt Template

**Goal:** Use after a concrete failure.

```text
We have a bug in Cash Chase Arena: [PASTE ERROR, LOGS, OR STEPS HERE]. Reproduce or reason from the provided evidence, inspect the relevant files, identify the smallest safe fix, implement it, and run targeted validation. Keep the fix narrow. Explain what changed and why. Do not add unrelated features.
```
