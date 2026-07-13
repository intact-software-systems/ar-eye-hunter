# Cash Chase Arena — Codex Prompt Pack

Updated: July 13, 2026

## How to use this prompt pack

- Use one prompt at a time and stop at its review gate.
- Always paste the global context before the selected prompt.
- Treat the current repository and public Rallar code/tests as stronger evidence than old assumptions.
- Review diffs, preserve unrelated user changes, and report every validation command as passed, failed, or skipped.
- Do not begin a later gate because an implementation detail makes it convenient.
- Product authority: `Cash_Chase_Arena_Product_Owner_Document.md`.
- Architecture authority: `Cash_Chase_Arena_Rallar_React_Three_Plans.md`.
- Engineering authority: `Cash_Chase_Arena_Engineering_Standards.md`.
- Execution authority: `Cash_Chase_Arena_Implementation_Plan.md`.
- Presentation detail: `Cash_Chase_Arena_Characters_Controls_Camera_Plan.md`.
- Audit rationale: `Cash_Chase_Arena_Complete_Review.md`.

## Global context to paste before every prompt

```text
You are working on Cash Chase Arena (CCA), an original-IP, fast-loading, unranked 2–8 player browser chase-survival game inside the existing Rallar monorepo.

Before changing code, read AGENTS.md, Cash_Chase_Arena_Engineering_Standards.md, and the relevant repo skills under .agents/skills/**. Inspect current public Rallar APIs and existing game consumers; repository code and tests are authoritative because planning docs can lag.

Product and architecture rules:
- Rallar is the only application communication platform.
- Compose current Rallar Rooms, Messages, Realtime, Game, Match, Motion, Data, AI, diagnostics, and shared-test APIs.
- Do not create raw WebSocket, RTCPeerConnection, DataChannel, custom netcode, host election, HostLease, lane manager, message bus, state framework, persistence framework, CRDT implementation, or AI lifecycle infrastructure in CCA.
- Prefer GroupRef/roomRef, rooms.createAndSwitch/rooms.session, Rallar Game, rallar.realtime.room<T>(...), and rallar.messages.room<T>(...) at their intended abstraction level.
- Browser-director MVP is unranked and room-trusted. Rallar appointment epoch is the only authority epoch.
- Caught and cashed-out players spectate; no MVP respawn/reentry.
- One scoped participant has one active seat. Late joiners and expired reconnects spectate; voluntary leave loses unbanked credits; director/backup eligibility is independent of runner state.
- Exactly three MVP missions: disable Sentinel gate, open cash-out window, double-reward zone.
- Deterministic fallback content always starts without AI. AI and CRDT are post-core and never live authority.
- Pure deterministic rules live in packages/cash-chase-arena and do not import React, renderer, browser globals, Rallar runtime, storage, or AI.
- Authoritative time is integer ticks. Validate/quantize inputs at the boundary, use stable key ordering and fixture-locked xorshift32 state, and hash a canonical versioned encoding. Node/Chromium/Firefox/WebKit parity is required.
- Authoritative/prediction simulation uses a dedicated worker before 3D load.
- React/ReactDOM owns low-frequency DOM UI only; no per-frame React entity state.
- Renderer is behind CashChaseRenderer. Direct Three is the leading candidate but must win an identical measured bake-off against modular Babylon. Do not add R3F, Drei, postprocessing, or a physics engine.
- Use native Web Audio and browser input/worker APIs. Do not add external state, networking, persistence, audio, or validation frameworks.
- Desktop keyboard/mouse active play; mobile lobby/spectator only.
- Keep provider and TURN secrets server-side. Escape generated/player text and bound payloads, rates, queues, prompts, content, logs, and storage.
- No app-owned CCA match/game data is persisted server-side in MVP.
- Generic migration/topology gaps belong in shared Rallar packages, not CCA app netcode.
- Complete the non-3D migration feasibility spike before renderer work; full generic/public migration hardening remains Gate 6.
- Use typed operational error results, abort/generation ownership, idempotent disposal, bounded/redacted diagnostics, exact protocol/build compatibility rules, and explicit page/audio/WebGL lifecycle handling.
- Use the repository Prettier, ESLint, TypeScript, Vitest, and Playwright toolchain with checked-in CCA commands and dependency-boundary checks; add no competing tool.
- Add tests first, use focused validation before broad suites, and stop when the requested gate passes.

Workspace targets:
- apps/cash-chase-arena (workspace cash-chase-arena-app)
- packages/cash-chase-arena (workspace @ar-eye-hunter/cash-chase-arena)
- packages/tests/cash-chase-arena
```

## 0. Repository orientation and gate check

```text
Inspect the repository and the six authoritative/review CCA documents, including the engineering standards. Read the relevant Rallar platform, code-writing, games, realtime, testing, and AI skills plus direct references. Inspect current Rallar Game, Match, Motion, Rooms, typed messages, Data, authority, topology, existing AR Eye/Relic consumers, and focused tests.

Do not change code. Report:
1. current commit/worktree state and unrelated changes to preserve;
2. whether apps/cash-chase-arena or packages/cash-chase-arena already exists;
3. current public APIs the next gate should compose;
4. exact files the next gate would create/modify;
5. focused validation commands and service prerequisites;
6. any conflict with the approved CCA documents.

Stop after orientation.
```

## 1. Pure package and protocol

```text
Implement Gate 1 Task 1.1 from the CCA implementation plan.

Create packages/cash-chase-arena following packages/relic-hunters conventions and add packages/tests/cash-chase-arena/protocol.test.ts. Define protocol/simulation/content/hash/build compatibility versions, payload bounds, configuration types/default playtest values, the compact CashChaseInput payload, strict narrow validators, typed protocol failure results, and package format/lint/typecheck/test/boundary commands.

Rallar Game envelope owns senderId, seq, sentAtEpochMs, matchId, roomId, and directorEpoch. Reject attempts to duplicate/trust those fields in CashChaseInput. Do not add runtime dependencies or browser/Rallar/renderer imports.

Write failing tests first for valid input and every invalid version/tick/number/range/trusted-field/excess-property case, compatible additive field, hard-cut incompatible client, and prohibited dependency fixture. Run format, lint, focused test, package typecheck, and boundary checks. Report exact results and stop.
```

## 2. Deterministic movement and collision

```text
Implement Gate 1 Task 1.2 only.

Add serializable CashChaseState, fixture-locked xorshift32 state with zero normalized to 0x6d2b79f5, fixed 30 Hz integer-tick simulation time, input application by envelope-derived sender, camera-relative normalized movement, stamina/sprint, dash, contextual vault, bounds, and deterministic capsule/obstacle collision. Quantize authoritative position to 1 millimetre and yaw to 1/4096 turn after mutation; sort simultaneous inputs/entities/collisions/events by stable keys; encode canonically and hash with fnv1a64-v1 to 16 lowercase hexadecimal digits.

No Date.now, Math.random, DOM, storage, Rallar runtime, React, renderer, physics engine, or hidden global state in the pure package. Missing input may repeat bounded held movement but must not repeat dash/vault/interact edges.

Write failing RNG fixtures, canonical-hash, stable-order, determinism, movement, collision, and action-consumption tests first. Run identical fixtures in Node, Chromium, Firefox, and WebKit workers and compare hashes; any mismatch blocks the gate and requires an integer/lookup-table replacement. Add the representative reporting benchmark without claiming a bottleneck. Stop after Gate 1.2 passes.
```

## 3. Arena, Sentinels, missions, score, snapshots, checkpoints

```text
Implement Gate 1 Task 1.3 only.

Add deterministic fallback arenas and validation; Sentinel patrol/chase/search/reset/tag; exactly three mission templates; the approved 240-second/10-credit/60-second-station initial configuration; catch loss and cash-out banking into spectator; timer-expiry unbanked loss; stable standings; duplicate-seat/late-join/reconnect-grace/voluntary-leave/rematch rules; compact full snapshots; migration checkpoints; canonical state hash/restore; renderer-neutral presentation frames.

Write failing tests and property/fuzz cases for invalid layouts, all Sentinel states, each mission's eligibility/timing/effect, no rescue/forced-movement mission, economy/end/lifecycle conditions, standings tie-breaks, compact preset IDs, simultaneous ordering, and corrupted/wrong-version/wrong-match/old checkpoint rejection.

Run all pure CCA tests, package typecheck, and forbidden-import/global search from the implementation plan. Stop when Gate 1 exits.
```

## 4. Browser app and accessible lobby

```text
Implement Gate 2 Tasks 2.1 and 2.2 without game transport or 3D.

Create apps/cash-chase-arena as Vite + React/ReactDOM. Build semantic signed-out/connecting/lobby/ready/error/mobile-unsupported states. Compose the existing Rallar singleton/facades for auth/session, scoped room createAndSwitch/join/session/leave, people/presence, and disposal. Preserve roomRef. Do not call raw API integration or transport APIs.

Add tests for state derivation, typed/redacted operational errors, abort/generation handling, auth expiry, duplicate active seat, late-join spectator, reconnect grace, stale async completion, room switch, voluntary leave, idempotent disposal, keyboard/focus labels, and visible Playwright create/join/leave/ready controls. Ensure the lobby does not import or load renderer/AI code. Build and report initial minified/gzip/Brotli chunks against the 250 KiB lobby budget.

Stop before Rallar Game integration.
```

## 5. Rallar Game authority spine

```text
Implement Gate 2 Task 2.3.

Compose createRallarBrowserMatch and its underlying Rallar Game handle using roomRef, current default lane roles, capability reporting, deterministic host/backup election, current appointment policy, readiness, input, reliable intent/event, snapshot, sync, diagnostics, participants, standings, and room-trusted result.

Do not implement CCA HostCapability/HostLease/election/lane presets/envelope ordering. CCA supplies device readings, payload validators, match/setup data, and UI mapping only.

Write failing tests for elected-only appointment, owner-offline fallback, exact/bounded lane readiness, partial/no-target egress, no fresh director, wrong room/match/sender/epoch/sequence, sync, stop/disposal, and room-trusted result. Add a static test/search proving no raw transport or duplicate lease/election.

Run CCA tests/build plus focused existing Rallar Game/room/message tests. Stop when two contexts agree on room, host, backup, epoch, and readiness.
```

## 6. Worker, input, snapshots, and 2D vertical slice

```text
Implement Gate 3 Tasks 3.1 and 3.2.

Create versioned worker protocol, director/predictor modes, bounded structured-clone messages, bounded catch-up, pause/resume, state/snapshot/checkpoint output, abort/stale-generation protection, and idempotent disposal. Capture/remap keyboard/mouse into CashChaseInput and reset on every UI/visibility/page/pointer/auth/room/offline boundary.

Send latest input at 20 Hz through Rallar Game. Apply envelope sender identity in the director worker. Publish full snapshots at 12 Hz and reliable setup/start/event/sync through Rallar Game or typed room messages at their intended level. Render only a DOM/canvas-2D debug playfield.

Write worker parity/lifecycle and network adapter tests first. Add visible two-browser Playwright flow for start, movement, one mission, catch/cash-out, and result under induced jitter/loss. Record payload, serialize, tick, and outbound metrics. Stop before 3D.
```

## 7. Rallar Motion presentation

```text
Implement Gate 3 Task 3.3.

Create CashChaseMotionPresenter using RallarMotion buffers, adaptive delay, kinematics, correction blender, discontinuity classification, and diagnostics. Use receiver-local observed time; sender time is metadata only. Remote entities interpolate, extrapolate only within the bound, then hold. Local prediction blends small errors and snaps large/recovery errors.

Write failing tests for duplicate/stale samples, mode/confidence, adaptive delay, interpolation/extrapolation/hold, catch/cash-out/recovery/match-epoch discontinuities, entity removal, and disposal. Do not reimplement Rallar Motion math.

Feed the debug view from presentation frames and run the two-browser vertical slice. Stop when Gate 3 exits with recorded traces.
```

## 8. Pre-renderer migration feasibility

```text
Implement Gate 3 Task 3.4 as a non-3D Rallar feasibility spike. Do not create a CCA transport, HostLease, election, authority epoch, or public production API merely to make the spike pass.

Using current Rallar Game election, appointment, lane, envelope, status, and diagnostics contracts, model opaque checkpoint delivery to the elected backup, validation/acknowledgement, stale pause, one-higher-epoch appointment, promotion/restore callback, recovery commit, old-epoch rejection, and bounded abort.

Write failure cases first for no backup, corrupt/wrong checkpoint, missing ack, random-tick director loss, promotion failure, duplicate commit, timeout, and returning old director. Run at least 100 deterministic random-tick cases and prove restored hash equality or clean interruption within 10 seconds. Record required generic interfaces and compatibility/bundle questions in apps/cash-chase-arena/docs/migration-feasibility.md. Remove throwaway app-local implementation and stop. Renderer work is blocked if feasibility is not proven.
```

## 9. Complete procedural loop, Rallar Data, audio, and HUD

```text
Implement Gate 4 only.

Integrate 2–8 players, fallback arenas, all three missions, configured Sentinels, score/catch/cash-out/spectator/results/rematch, one-seat/late-join/disconnect-grace/voluntary-leave/timer-expiry/tie-break/rematch rules, SetupCommit/SetupReady/shared future start, reconnect/late-join full sync, and deterministic fallback failures.

Create apps/cash-chase-arena/docs/playtest-protocol.md with consent, fixed build/environment, facilitator script, mission-comprehension timing, completion/rematch evidence, dominant-strategy observations, issue severity, and redacted export/deletion handling. Core-loop playtest evidence must justify Gate 5.

Add Rallar Data definitions for settings, loadout selection, room recents, and bounded/redacted session debug log with version, migration, entry/byte/TTL caps, and validation tests. Prove simulation does not import/read Data and server CCA code opens no game store.

Add native Web Audio gesture unlock, buses, bounded voices, mission/interact/dash/caught/cash-out/recovery cues, reduced intensity, mute, and teardown. Add semantic keyboard/focus HUD with color/audio redundancy, remapping, reduced motion, and HUD scale.

Run pure/app/Rallar focused tests, visible 2–8 context flows, build, and accessibility checks. Stop before renderer work.
```

## 10. Renderer bake-off

```text
Implement Gate 5 Task 5.1 only. Stop immediately if Gate 3.4 migration feasibility or Gate 4 core-loop playtest exit evidence is missing.

Define CashChaseRenderer exactly as the architecture document specifies. Build identical direct-Three and modular-Babylon prototypes for 8 runners, 6 Sentinels, 40 obstacles, mission objects/stations, third-person obstruction camera, Motion-fed transforms, basic materials, diagnostics, and disposal.

Do not use R3F, Drei, postprocessing, a physics engine, or per-frame React state.

Measure and document dependency/license changes, minified/gzip/Brotli renderer chunk, cold first frame, p50/p95 frame time, heap/exposed GPU/draw/resource metrics, camera/asset ergonomics, WebGL context loss/restore, stale-load cancellation, and 20 mount/load/dispose cycles. Use the same environment/workload for both. Choose the lowest total-risk option meeting the <=500 KiB Brotli and runtime budgets, remove the losing runtime dependency, record the renderer ADR, and stop for review.
```

## 11. Selected renderer, camera, characters, and visual QA

```text
Implement Gate 5 Task 5.2 using only the approved renderer.

Render procedural arena, fixed capsule/debug overlay, three shape/pattern silhouettes, six accents, Sentinels, mission objects, stations, and restrained effects. Implement the renderer-neutral third-person camera, obstruction handling, restrained threat assist, camera states, resize/graphics tiers, and full disposal. Motion presentation frames drive remote/dynamic transforms; React does not render per-frame scene entities.

Add tests/visual QA for nonblank canvas, capsule/visual alignment, non-color readability, camera clipping/control, HUD safe area, reduced motion, renderer lifecycle, context loss/restore, asset fallback, page background/resume, frame/memory budgets, and supported viewports. Stop when Gate 5 exits. Do not add GLB characters yet.
```

## 12. Generic Rallar Game migration

```text
Implement Gate 6 Task 6.1 as generic Rallar product work, not CCA-specific transport.

Before editing, inspect current Rallar Game match/types/diagnostics, director appointment, existing stale recovery behavior, public snapshots, bundle boundaries, both game consumers, and the Gate 3.4 feasibility report. Design typed generic checkpoint publish-to-backup, acknowledgement, stale pause, deterministic re-election/appointment, promotion callback, recovery commit, timeout/abort, and diagnostics while treating checkpoint payload as opaque. Do not preserve a spike interface that duplicates or weakens Rallar ownership.

Write failing public API and state-machine tests first. Preserve existing exports/imports and behavior. Run focused Rallar Game tests, shared-web typecheck, public API snapshots, browser bundle boundaries, and AR Eye/Relic builds. Do not implement director-star topology in this task. Stop for review after the generic migration surface passes.
```

## 13. CCA migration and recovery hardening

```text
Implement Gate 6 Task 6.2 using the approved generic Rallar migration API and CCA checkpoint/restore functions.

Checkpoint at the measured cadence and critical events; validate/ack latest tick/revision/hash. On stale authority, pause outcomes, deterministically re-elect/appoint a higher epoch, restore/promote the acknowledged checkpoint, send recovery commit/full snapshot, reset Motion discontinuities, and resume at a shared future tick. Reject all returning old-director/old-epoch traffic and results. End interrupted without result after 10 seconds or invalid/missing checkpoint.

Write deterministic random-tick failure tests plus real multi-context director close/background/offline/return flows. Run at least 100 harness migrations and the controlled 9/10 <=10-second acceptance matrix. Report resumed, cleanly interrupted, split-brain, state-hash, and timing results. Stop when Gate 6 exits.
```

## 14. Browser, accessibility, performance, security, and staging

```text
Implement Gate 7 as separate focused changes with review between them.

Add supported Chromium/Firefox/WebKit CI coverage where practical and a manual real-Safari/TURN checklist. Test visible auth/create/join/ready/start/move/mission/cash-out/results/rematch/reconnect/migration flows plus mixed-browser pairs, visibility/page lifecycle, offline/online, audio interruption, WebGL context loss, stale cached client, and hard-cut protocol refresh. Verify remapping, focus, zoom/HUD scale, reduced motion/intensity, contrast, non-color/non-audio cues, and mobile lobby/spectator blocking.

Measure cold/warm lobby, renderer lazy load/first frame, p50/p95 frame, worker tick, snapshot serialization/bytes, direct/TURN bandwidth, heap/resources, Rallar Data/debug caps, audio voices, 15-minute and 20-round soaks at 2/4/8 players. Put generated profiles under tmp/perf and optimize only measured problems.

Review secrets, payload/rate/queue/room/prompt/content/storage bounds, duplicate-seat/removal/resource-exhaustion abuse, typed error codes, diagnostic redaction/caps, text escaping, room-trusted disclosure, interrupted result behavior, HTTPS/WSS/CSP/origins/ICE/TURN/env/health/static hosting, cache invalidation, rollback, dependency/asset licenses, vulnerabilities, provenance, and TURN capacity/cost. Add shared-test recipes/artifacts for CCA traffic/recovery failures.

Create the threat model, dependency-and-asset register, staging runbook, and release checklist named in the implementation plan. Record exact build/protocol/browser/renderer/Rallar versions, controlled success target, cache invalidation, feature-disable switches, rollback owner/steps, and every unresolved skipped live test.

Run every Gate 7 command and report passes/failures/skips. Do not proceed to AI until all release gates pass.
```

## 15. Post-core server Rallar AI proposals

```text
Only run after Gates 0–7 pass.

Add strict CCA proposal schemas/domain validators for optional arena, mission deck, cosmetic, flavor, or tutorial proposals. Use current shared Rallar AI schema/hash/lifecycle/dedupe/governance/mock/evaluation helpers and createRallarServerAi with server-only credentials and limits.

Test valid, schema-invalid, domain-invalid, stale, duplicate, unauthorized, timeout, unavailable provider, and deterministic fallback. AI never blocks match start, changes live authority, or persists CCA proposal/catalog data server-side. Optional bounded local debug replay uses Rallar Data.

Run focused Rallar AI plus CCA tests and prove the critical client bundle/start path does not import provider/browser-model code. Stop after this optional feature.
```

## 16. Post-MVP GLB or CRDT feature

```text
Do not combine these features.

For GLB: require procedural character acceptance first. Add one shared rig, stable manifest/attachments/clips, dev-only glTF Transform, asset budgets, capsule alignment, renderer disposal, and browser performance tests. No mesh collision or root-motion authority.

For CRDT: require a separately approved creator/review product spec. Use Rallar CRDT for authored state only. Convert accepted content once into a strictly validated pre-round SetupCommit. No active match state, score, position, mission outcome, authority, or recovery data may live in CRDT.

Implement only the selected approved feature and run its focused tests/build/visual or CRDT convergence/health checks.
```

## 17. Focused review prompt

```text
Review the current CCA gate against the authoritative product, architecture, engineering standards, presentation, and implementation documents.

Start with findings, ordered by severity. Focus on correctness, duplicated Rallar functionality, raw transport leaks, scope/identity ambiguity, authority epoch/order, numeric/canonical-hash determinism, compatibility, typed errors, cancellation/idempotent lifecycle cleanup, diagnostics redaction/caps, readiness/backpressure/fallback, Motion mapping, Data/AI/CRDT boundary violations, accessibility, security/trust disclosure, dependency/asset governance, rollback, and unmeasured performance claims.

Support every finding with file/line evidence and a failing scenario. Do not implement fixes unless explicitly asked. State which gate cannot exit and which exact validation would prove it.
```

## 18. Bug-fix prompt

```text
CCA failure evidence:
[paste exact steps, expected/actual behavior, logs, screenshots, test output, profile, or artifact]

Use systematic debugging before proposing a fix. Reproduce or isolate the failure, inspect the responsible Rallar/CCA layer, and identify the root cause with evidence. Preserve authority, package, dependency, scope, determinism, compatibility, error, cancellation, and diagnostic boundaries. Add the smallest failing regression test first, implement the narrow safe fix, run format/lint/typecheck plus focused validation and any affected gate check, and report passed/failed/skipped commands. Do not add unrelated features or bypass a Rallar abstraction to make the symptom disappear.
```
