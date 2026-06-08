# Cash Chase Arena — Codex Prompt Pack

Prepared: May 22, 2026

## How to use this prompt pack

- Use one prompt at a time.
- Review diffs and run validation before continuing.
- Keep the product and implementation documents in the repo.
- Keep secrets server-side only.

## Global context to paste before any prompt

```text
Project context:
Cash Chase Arena is a browser-native multiplayer chase-survival game. It uses a WebRTC-first super-peer model: one automatically elected browser acts as temporary match host. The backend handles lobby, signaling, ICE config, AI layout generation, and recovery only. After match handoff, gameplay traffic should use WebRTC DataChannels. The MVP uses procedural WebGL/Babylon rendering, host-owned simulation, no real money, original IP, and AI-generated candidate layouts validated by deterministic code.

Engineering rules:
- Keep OpenAI API keys and TURN secrets server-side only.
- Prefer small, testable modules.
- Add or update tests for new logic.
- Run typecheck and targeted tests after changes.
- Do not implement full anti-cheat yet; prioritize match consistency.
- Avoid direct references to existing TV show names, characters, costumes, or branded presentation.
```

## 0. Repository Orientation and Build Strategy

**Goal:** Have Codex inspect the repo or create a build plan before editing.

```text
You are working on Cash Chase Arena, a browser-native WebRTC-first multiplayer chase game. Before writing code, inspect the repository structure, package manager files, TypeScript config, and any existing docs. Summarize what exists, identify missing foundations, and propose a minimal implementation order. Do not make code changes yet unless the repo is empty and you need to create a README placeholder. End with the exact commands you recommend running for install, typecheck, tests, and local development.
```

## 1. Monorepo Scaffold

**Goal:** Create the basic project structure.

```text
Create a TypeScript monorepo for Cash Chase Arena using pnpm workspaces. Add apps/web-client for a Vite browser client, apps/backend for a Node.js backend, and packages/shared, packages/netcode, packages/simulation, and packages/procedural. Add root scripts for dev, build, lint, typecheck, and test. Keep the first implementation minimal: no Babylon yet, just a web page and backend health endpoint. Add README instructions. After changes, run install if needed, then run typecheck and build. Report any failures and fixes.
```

## 2. Shared Schemas and Protocol Types

**Goal:** Define the authoritative shared data model.

```text
In packages/shared, implement Zod schemas and inferred TypeScript types for PlayerId, MatchId, HostCapability, HostLease, ClientInput, HostSnapshot, PlayerState, SentinelState, MissionCard, MissionState, ArenaLayout, ReliableGameEvent, and HostMigrationState. Include constants for arena bounds, match tick rate, snapshot rate, channel names, and protocol version. Add unit tests for schema validation, including invalid coordinates, missing IDs, and bad mission templates. Export everything from a package index. Run typecheck and tests.
```

## 3. Backend Lobby and WebSocket Signaling

**Goal:** Build the minimal backend coordinator.

```text
In apps/backend, implement a Node.js WebSocket lobby server. It should support create room, join room, leave room, capability report, and signaling relay messages for OFFER, ANSWER, and ICE. It must not run the game simulation. Add room state with player list and connection IDs. Add validation for incoming messages using packages/shared schemas. Include a simple health endpoint and structured console logs. Add tests for room lifecycle and signaling relay behavior. Run typecheck and tests.
```

## 4. Host Election and Host Lease

**Goal:** Select one browser as the match host.

```text
Add host election to the backend. When all lobby players are ready or the host clicks start, score HostCapability reports using RTT, FPS, hardwareConcurrency, deviceMemory, mobile penalty, battery-saver penalty, and previous disconnect penalty. Issue a HostLease containing matchId, hostPeerId, backupPeerId, hostEpoch, and expiresAt. Broadcast the lease to all players. Add tests for scoring, deterministic tie-breaks, mobile penalty, missing capability fallback, and backup host selection. Run typecheck and tests.
```

## 5. Web Client Lobby Shell

**Goal:** Create the browser lobby UI and backend connection.

```text
In apps/web-client, build a minimal lobby UI: create/join room, display room code, list players, mark ready, show selected host/backup in a debug panel, and show connection state. Connect to the backend WebSocket. Send a HostCapability report based on measured signal RTT, approximate FPS sample, navigator.hardwareConcurrency, navigator.deviceMemory if available, and mobile detection. Keep UI simple and functional. Run typecheck and build.
```

## 6. WebRTC Peer Connection Manager

**Goal:** Establish host-client WebRTC connections.

```text
In packages/netcode and apps/web-client, implement a WebRTC PeerConnectionManager. Use backend WebSocket only for signaling. After receiving HostLease, the host creates peer connections to each client, and clients connect to the host. Exchange OFFER, ANSWER, and ICE through the signaling relay. Add connection state tracking and debug output. Use configurable iceServers from backend config. Do not implement gameplay yet. Add a ping DataChannel or use the metrics channel to prove connectivity. Run typecheck and build.
```

## 7. Negotiated DataChannels and Backpressure

**Goal:** Create the WebRTC channel protocol.

```text
Implement negotiated WebRTC DataChannels with fixed IDs: ctrl=0, input=1, snapshot=2, event=3, replication=4, metrics=5. Configure ctrl/event/replication as ordered reliable, input as unordered with short maxPacketLifeTime, snapshot as unordered with short maxPacketLifeTime, and metrics as unordered. Add sendReliable and sendDroppable helpers that check readyState and bufferedAmount. Add lightweight JSON encoding first, with TODOs for binary encoding later. Add tests for channel definitions and helper behavior where possible. Run typecheck and build.
```

## 8. Browser Host Runtime Skeleton

**Goal:** Make the elected host act as the match server.

```text
In packages/simulation, implement BrowserHostRuntime with a fixed tick loop, input queue, player state map, match phase, tick counter, and snapshot builder. In the web client, instantiate this runtime only on the elected host. Non-host clients send ClientInput over the input channel at 20-30Hz. The host broadcasts HostSnapshot over the snapshot channel at 10-20Hz. For now, represent players as 2D positions and apply simple movement. Add deterministic unit tests for movement update and snapshot creation. Run typecheck, tests, and build.
```

## 9. Client Snapshot Interpolation

**Goal:** Render host state smoothly in clients.

```text
In the web client, implement a GameClientRuntime that sends input to the host, receives HostSnapshot messages, and maintains a small interpolation buffer. Render a simple 2D or DOM-based debug view first showing player dots, host tick, ping, and snapshot age. Include local input capture for WASD/arrow keys and sprint. Do not add Babylon yet. Add diagnostics for missed snapshots and DataChannel bufferedAmount. Run typecheck and build.
```

## 10. Procedural Arena Layout and Validator

**Goal:** Create deterministic maps before AI.

```text
In packages/procedural, implement ArenaLayout types if not already present, a fallback map generator, and a LayoutValidator. Validate coordinate bounds, spawn zone clearance, obstacle count, object IDs, cash-out station count, mission terminal count, sentinel spawn count, and simple obstacle overlap. Add at least three fallback layouts with different cover patterns. Add unit tests for valid maps and rejected invalid maps. Wire the backend to send a validated fallback map as MAP_COMMIT before match start. Run typecheck and tests.
```

## 11. Babylon Procedural Renderer

**Goal:** Move from debug view to 3D scene.

```text
Add Babylon.js to apps/web-client and create a GameEngineManager with an async create() factory. Use WebGL procedural rendering as the default. Build the arena from ArenaLayout: floor, boundary walls, obstacles, cash-out stations, terminals, Sentinel gates, player capsules, and Sentinel capsules. Keep materials simple. Do not require WebGPU or external assets. Connect HostSnapshot data to rendered entity positions. Add a debug overlay that can be toggled. Run typecheck and build.
```

## 12. Sentinel AI

**Goal:** Add the core chase threat.

```text
In packages/simulation, implement host-owned Sentinel AI. Sentinels should have states PATROL, CHASE, SEARCH, and RESET. Use simple waypoint patrols from the ArenaLayout, distance-based detection, line-of-sight approximation using obstacle blockers if feasible, chase movement with max speed, and tag radius. Host decides eliminations and sends ReliableGameEvent messages. Add unit tests for detection, chase, tag, and reset behavior. Run typecheck and tests.
```

## 13. Scoring and Cash-Out

**Goal:** Make the game loop meaningful.

```text
Implement score accumulation in BrowserHostRuntime: +10 credits per second alive, banked score, unbanked score, caught behavior, survival bonus, and match end scoreboard. Add CashOutStation interaction: clients send interaction intent, host validates proximity and active phase, then banks score and changes player state to CASHED_OUT or SPECTATOR. Add UI for current score, banked score, and final scoreboard. Add unit tests for score and cash-out rules. Run typecheck, tests, and build.
```

## 14. Mission Deck and Mission Scheduler

**Goal:** Prevent passive hiding and add strategy.

```text
Implement mission templates DISABLE_SENTINEL_GATE, OPEN_CASHOUT_WINDOW, DOUBLE_REWARD_ZONE, RESCUE_CAPTURED_PLAYER, and FORCED_MOVEMENT_ALARM. Create a MissionScheduler that selects eligible mission cards based on match time and state. Host validates terminal interactions and applies mission success/failure effects. Add mission alert UI with objective, countdown, reward, and failure consequence. Add unit tests for mission eligibility, completion, timeout, and effects. Run typecheck, tests, and build.
```

## 15. AI Layout and Mission Deck Backend

**Goal:** Add OpenAI-assisted variety safely.

```text
Add an AI layout endpoint to apps/backend. Keep the OpenAI API key server-side only, read from environment variables, and never expose it to the client. Use Structured Outputs with a strict schema for candidate ArenaLayout and MissionDeck. Sanitize theme input. After model output, run LayoutValidator and mission template validation. If validation fails, use a fallback layout and fallback mission deck. Add tests by mocking the OpenAI response: valid output, invalid output, and API failure. Run typecheck and tests.
```

## 16. Match Start Handoff Flow

**Goal:** Connect lobby, AI/fallback map, WebRTC, and runtime.

```text
Implement the full match start workflow. Host clicks Start. Backend elects host and backup, obtains a validated map and mission deck, broadcasts MAP_COMMIT, coordinates WebRTC setup, waits for client ready acknowledgements, then sends MATCH_HANDOFF. After handoff, gameplay traffic should use WebRTC DataChannels. Add status UI for each phase: electing host, generating map, connecting peers, building arena, ready, active. Add integration tests or a manual smoke-test script. Run typecheck, tests, and build.
```

## 17. Backup Host Replication and Migration

**Goal:** Recover from host disconnects.

```text
Implement host replication to the backup host over the replication DataChannel. Replicate HostMigrationState once per second and after critical reliable events. Detect host failure via missed snapshots and connection state changes. Notify backend recovery channel. Backend issues a new HostLease with incremented hostEpoch. Backup resumes simulation and broadcasts a recovery snapshot. Add debug controls to simulate host disconnect. Add tests for migration state serialization and epoch rejection. Run typecheck, tests, and build.
```

## 18. Transport Metrics and Debug Overlay

**Goal:** Make networking observable.

```text
Add a debug overlay showing playerId, roomId, matchId, hostPeerId, backupPeerId, whether this browser is host, hostEpoch, WebRTC connection states, DataChannel states, ping estimate, snapshot rate, missed snapshots, bufferedAmount per channel, current tick, FPS, and selected graphics tier. Add a metrics channel message exchanged every few seconds. Ensure overlay can be toggled and is hidden by default. Run typecheck and build.
```

## 19. Playtest Hardening

**Goal:** Prepare for first external test.

```text
Harden the MVP for a 2-8 player playtest. Add clear error states for failed WebRTC connection, missing TURN config, host migration failure, AI generation failure, and browser unsupported features. Add a simple onboarding panel explaining peer-hosted WebRTC matches. Add a fallback to procedural WebGL. Add a manual QA checklist in docs/playtest-checklist.md. Run typecheck, tests, build, and a local smoke test if possible.
```

## 20. Deployment Preparation

**Goal:** Make the app deployable.

```text
Prepare staging deployment. Add environment variable documentation for backend port, allowed origins, OpenAI API key, AI model name, ICE servers, TURN username/credential, and logging mode. Add Dockerfile or deployment notes for the backend and static hosting notes for the client. Ensure HTTPS/WSS assumptions are documented. Add health checks. Make sure no secrets are committed. Run typecheck, tests, and build.
```

## 21. Focused Code Review Prompt

**Goal:** Use Codex to review after each milestone.

```text
Review the most recent implementation for Cash Chase Arena. Focus on correctness, missed edge cases, TypeScript type safety, resource cleanup, WebRTC lifecycle bugs, DataChannel backpressure, and mismatch with the product/implementation docs. Do not rewrite large areas unless necessary. Produce a prioritized issue list, then fix only the top critical issues. Run the most relevant validation commands and report results.
```

## 22. Bug-Fix Prompt Template

**Goal:** Use after a concrete failure.

```text
We have a bug in Cash Chase Arena: [PASTE ERROR, LOGS, OR STEPS HERE]. Reproduce or reason from the provided evidence, inspect the relevant files, identify the smallest safe fix, implement it, and run targeted validation. Keep the fix narrow. Explain what changed and why. Do not add unrelated features.
```
