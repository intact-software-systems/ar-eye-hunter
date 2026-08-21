# Cash Chase Arena Implementation Plan

Updated: July 13, 2026

> **For agentic workers:** implement one gate at a time, use test-first changes, request review at every exit gate, and do not begin a later gate until the current evidence passes. Use the repository's relevant Rallar, code-writing, and testing skills before changing packages or apps. Treat `Cash_Chase_Arena_Engineering_Standards.md` as normative.

**Goal:** Build an original, fast-loading, unranked 2–8 player browser chase game that composes current Rallar product surfaces and proves deterministic gameplay, peer-host recovery, accessibility, and browser performance before optional AI or asset expansion.

**Architecture:** Pure deterministic rules live in `packages/cash-chase-arena`; the browser app composes Rallar Game and runs authoritative/prediction simulation in a worker; React owns low-frequency DOM UI; Rallar Motion feeds a renderer-neutral scene adapter. Generic migration or topology capabilities belong in shared Rallar packages, not app-local netcode.

**Tech stack:** Existing TypeScript, npm workspaces, Vite, Vitest, Playwright, Rallar browser/server/shared-test packages, React/ReactDOM for DOM UI, native Worker/Web Audio/browser APIs, and one renderer selected by measurement.

## Global constraints

- Rallar is the only application communication platform.
- Do not create raw WebSocket, RTCPeerConnection, DataChannel, networking, state, persistence, CRDT, AI lifecycle, host-election, lease, or lane-manager infrastructure in CCA.
- Use `GroupRef`/`roomRef`, `rooms.createAndSwitch`/`rooms.session`, Rallar Game, room realtime/message helpers, and Rallar diagnostics before lower-level APIs.
- Browser-director MVP is unranked and room-trusted; interrupted rounds produce no result.
- Match authority never reads Rallar Data, CRDT, renderer, React, or AI output.
- Exactly three MVP missions: disable gate, open cash-out window, double-reward zone.
- Caught and cashed-out players spectate; there is no MVP respawn/reentry.
- No R3F, Drei, postprocessing, Rapier, external state/network/persistence/audio/validation framework, browser AI, or asset-heavy GLB pipeline.
- Desktop keyboard/mouse active play; mobile lobby/spectator only.
- Lobby critical JavaScript ≤250 KiB Brotli; lazy renderer ≤500 KiB Brotli before assets.
- Keep temporary profiles under `tmp/perf/`; do not commit generated profiles.
- Preserve current Rallar exports and existing game import paths unless a gate explicitly adds a generic public surface with snapshots/bundle checks.
- Follow the CCA engineering standards for functional-first code shape, strict `Readonly` types, typed operational errors, cancellation/generation ownership, idempotent disposal, protocol compatibility, diagnostics, dependency review, and release governance.
- Authoritative simulation uses integer ticks, boundary quantization, stable key ordering, serializable `xorshift32` state, and canonical versioned hashes; cross-engine parity is a Gate 1 exit condition.
- One active seat per scoped participant; late joiners and expired reconnects spectate; voluntary leave loses unbanked credits; network host eligibility is independent of runner state.
- Unsupported major protocol/simulation/content versions cannot ready, join active play, or restore a checkpoint.

## Workspace names and aliases

```text
app directory: apps/cash-chase-arena
app workspace name: cash-chase-arena-app
pure package directory: packages/cash-chase-arena
pure package name: @ar-eye-hunter/cash-chase-arena
TypeScript alias: @cash-chase-arena/* -> packages/cash-chase-arena/*
default app port: 5179
```

## Gate 0 — specification and baseline

### Task 0.1: Freeze accepted documents

**Files:**

- Review: `projects/cash-chase-arena/Cash_Chase_Arena_Product_Owner_Document.md`
- Review: `projects/cash-chase-arena/Cash_Chase_Arena_Rallar_React_Three_Plans.md`
- Review: `projects/cash-chase-arena/Cash_Chase_Arena_Characters_Controls_Camera_Plan.md`
- Review: `projects/cash-chase-arena/Cash_Chase_Arena_Engineering_Standards.md`
- Review: `projects/cash-chase-arena/Cash_Chase_Arena_Complete_Review.md`

**Actions:**

- [ ] Confirm browser-director, migration, caught/spectator, disconnect/late-join/rematch/tie-break rules, initial economy, desktop scope, renderer gate, AI/CRDT deferral, protocol deployment, and manual/consented metrics decisions.
- [ ] Record the reference browser/hardware/network profile used for performance gates in `apps/cash-chase-arena/docs/performance-baseline.md` when the app is created.
- [ ] Record approved terminology and original-IP exclusions in `apps/cash-chase-arena/docs/content-guardrails.md`.

**Exit evidence:** No unresolved authority, MVP, renderer, mission-count, gameplay lifecycle, determinism, compatibility, mobile, telemetry, tooling, or precedence contradiction.

### Task 0.2: Specify engineering enforcement

**Files:**

- Review: `projects/cash-chase-arena/Cash_Chase_Arena_Engineering_Standards.md`
- Plan: `prettier.cca.config.mjs` covering CCA TypeScript, CSS, JSON, and Markdown when the pure package is scaffolded.
- Plan: `eslint.cca.config.mjs` covering the CCA app/package and dependency-boundary rules when the pure package is scaffolded.
- Create: `apps/cash-chase-arena/docs/decisions/0001-authority-trust-migration.md`
- Create: `apps/cash-chase-arena/docs/decisions/0002-deterministic-numeric-contract.md`
- Create: `apps/cash-chase-arena/docs/decisions/0003-protocol-compatibility-deployment.md`
- Test: `packages/tests/cash-chase-arena/package-boundaries.test.ts`
- Test: `apps/cash-chase-arena/tests/dependency-boundaries.test.ts`

**Actions:**

- [ ] Name the workspace `format:check`, `lint`, `typecheck`, `test`, and `build` commands that scaffolding tasks must add; do not select another formatter, linter, compiler, or test runner.
- [ ] Define static fixtures for forbidden pure-package imports/globals, raw game transports, CCA election/lease, renderer-to-simulation mutation, and server/local match authority; implement them with the relevant scaffold.
- [ ] Define stable CCA error families and a typed operational result shape with retryability, user-safe summary, and bounded diagnostic context.
- [ ] Define protocol/simulation/content/build compatibility fields and hard-cut stale-client behavior.
- [ ] Record the three accepted ADRs from the authoritative documents; renderer ADR remains proposed until the bake-off.
- [ ] Run format and document-link checks for the accepted documents; record the future lint, type-check, test, build, and boundary commands exactly.

**Exit evidence:** A fresh contributor or agent can discover the standards, exact future configuration paths, commands, prohibited fixtures, and ADR decisions before source scaffolding begins.

## Gate 1 — pure protocol and deterministic simulation

### Task 1.1: Scaffold the pure CCA package

**Files:**

- Create: `packages/cash-chase-arena/package.json`
- Create: `packages/cash-chase-arena/tsconfig.json`
- Create: `packages/cash-chase-arena/mod.ts`
- Create: `packages/cash-chase-arena/config.ts`
- Create: `packages/cash-chase-arena/protocol.ts`
- Create: `packages/cash-chase-arena/validation.ts`
- Create: `packages/tests/cash-chase-arena/protocol.test.ts`
- Create: `packages/tests/cash-chase-arena/package-boundaries.test.ts`

**Interfaces produced:**

```ts
export const CASH_CHASE_PROTOCOL_VERSION = 1 as const;
export const CASH_CHASE_SIMULATION_VERSION = 1 as const;
export const CASH_CHASE_CONTENT_MANIFEST_VERSION = 1 as const;
export const CASH_CHASE_HASH_VERSION = 1 as const;
export type CashChaseInput = Readonly<{
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
export function validateCashChaseInput(value: unknown): value is CashChaseInput;
export type CashChaseOperationError = Readonly<{
    code: `CCA-${string}`;
    retryable: boolean;
    summary: string;
    diagnostic?: Readonly<Record<string, string | number | boolean>>;
}>;
export type CashChaseOperationResult<T> =
    | Readonly<{ status: 'ok'; value: T; }>
    | Readonly<{ status: 'error'; error: CashChaseOperationError; }>;
```

**Test-first steps:**

- [ ] Write failing validation tests for valid input and invalid version, tick, NaN/infinite axes/yaw, out-of-range axes, and extra trusted identity/order fields.
- [ ] Run `npx vitest run packages/tests/cash-chase-arena/protocol.test.ts`; expect failures because the package does not exist.
- [ ] Add workspace metadata, strict TS config following `packages/relic-hunters`, configuration constants, payload types, and narrow validators.
- [ ] Add `prettier.cca.config.mjs`, `eslint.cca.config.mjs`, pure-package `format:check`, `lint`, `typecheck`, and `test` scripts, plus the planned forbidden-import/global boundary fixtures.
- [ ] Define `protocolVersion`, `simulationVersion`, `contentManifestVersion`, hash version, build compatibility, maximum payload sizes, and exact-match/compatible-additive validator behavior.
- [ ] Quantize validated axes/yaw once at the simulation boundary; reject forbidden identity/order fields and unsupported versions with typed CCA protocol results.
- [ ] Export only transport/renderer-neutral symbols from `mod.ts`.
- [ ] Run the focused test and `npm --workspace @ar-eye-hunter/cash-chase-arena run typecheck`; expect pass.

### Task 1.2: Implement state, movement, collision, and deterministic time

**Files:**

- Create: `packages/cash-chase-arena/state.ts`
- Create: `packages/cash-chase-arena/simulation.ts`
- Create: `packages/cash-chase-arena/movement.ts`
- Create: `packages/cash-chase-arena/collision.ts`
- Create: `packages/tests/cash-chase-arena/simulation.test.ts`
- Create: `packages/tests/cash-chase-arena/determinism.test.ts`
- Create: `packages/tests/cash-chase-arena/movement.test.ts`
- Create: `packages/tests/cash-chase-arena/collision.test.ts`
- Create: `packages/tests/cash-chase-arena/browser-parity.spec.ts`
- Create: `packages/tests/cash-chase-arena/playwright.config.ts`

**Interfaces produced:**

```ts
export function createInitialCashChaseState(
    input: CashChaseInitialStateInput
): CashChaseState;
export function applyCashChaseInput(
    state: CashChaseState,
    senderId: string,
    input: CashChaseInput
): CashChaseState;
export function stepCashChase(
    state: CashChaseState,
    config: CashChaseConfig
): CashChaseStepResult;
export function hashCashChaseState(state: CashChaseState): string;
```

**Test-first steps:**

- [ ] Write failing tests for fixed 30 Hz time, same-seed hash parity, camera-relative normalized movement, stamina, dash, vault eligibility, bounds, obstacle collision, and edge-action single consumption.
- [ ] Run the four focused files; expect missing implementation failures.
- [ ] Implement serializable seeded RNG state, explicit tick-based time, immutable-or-controlled state transitions, and simple deterministic capsule/AABB or swept collision.
- [ ] Implement fixture-locked `xorshift32` with zero normalized to `0x6d2b79f5`, explicit stable participant/entity/input/collision/event ordering, 1-millimetre position quantization, 1/4096-turn yaw quantization, canonical state encoding, and `fnv1a64-v1` hash output as 16 lowercase hexadecimal digits.
- [ ] Prohibit wall clock, DOM, Rallar, renderer, storage, and random global use in the pure package.
- [ ] Run focused tests twice and compare final hashes in Node, Chromium, Firefox, and WebKit workers; any parity failure blocks the gate and requires integer/lookup-table replacement of the differing operation.
- [ ] Add a representative 8-player simulation benchmark harness under `packages/tests/cash-chase-arena/performance.test.ts`, reporting rather than enforcing until the workload is stable.

### Task 1.3: Implement arena, Sentinels, missions, score, snapshots, and checkpoints

**Files:**

- Create: `packages/cash-chase-arena/arena.ts`
- Create: `packages/cash-chase-arena/sentinels.ts`
- Create: `packages/cash-chase-arena/missions.ts`
- Create: `packages/cash-chase-arena/scoring.ts`
- Create: `packages/cash-chase-arena/snapshots.ts`
- Create: `packages/cash-chase-arena/migration.ts`
- Create: `packages/cash-chase-arena/presentation.ts`
- Create corresponding tests under `packages/tests/cash-chase-arena/`

**Interfaces produced:**

```ts
export function validateArenaLayout(value: unknown): value is ArenaLayout;
export function createFallbackArena(
    seed: string,
    config: CashChaseConfig
): ArenaLayout;
export function buildCashChaseSnapshot(
    state: CashChaseState
): CashChaseSnapshot;
export function createMigrationCheckpoint(
    state: CashChaseState,
    inputSeqBySender: Readonly<Record<string, number>>
): CashChaseMigrationCheckpoint;
export function restoreMigrationCheckpoint(
    checkpoint: CashChaseMigrationCheckpoint
): CashChaseState;
export function derivePresentationFrame(
    snapshot: CashChaseSnapshot
): CashChasePresentationFrame;
```

**Test-first steps:**

- [ ] Add rejected-layout tests for bounds, overlap, spawn safety, reachability proxy, object IDs/counts, vault destinations, station/terminal/gate/Sentinel anchors.
- [ ] Add Sentinel patrol/chase/search/reset/tag tests, including obstruction and caught transition.
- [ ] Add exactly three mission tests for eligibility, non-overlap, countdown, success/failure, effects, and no rescue/forced-movement template.
- [ ] Add 240-second round, 10-credit accrual, 60-second station unlock, catch loss, cash-out banking/spectator, timer/no-active end, standings tie-break tests.
- [ ] Add duplicate-seat, late-join spectator, 10-second reconnect grace, voluntary-leave loss, timer-expiry unbanked loss, director-while-spectating, room-removal, and rematch reset tests.
- [ ] Add compact full snapshot and checkpoint validation/hash/restore tests, including corrupted/wrong-match/wrong-version/old-revision rejection.
- [ ] Add property/fuzz cases for validators, arena bounds/reachability, simultaneous-event ordering, checkpoint corruption, and canonical hash stability.
- [ ] Run all CCA pure tests; expect pass and no browser/Rallar/renderer imports.

**Gate 1 validation:**

```sh
npx vitest run packages/tests/cash-chase-arena
npm --workspace @ar-eye-hunter/cash-chase-arena run typecheck
npx playwright test --config packages/tests/cash-chase-arena/playwright.config.ts
rg -n "from ['\"](?:react|three|@babylonjs|@shared-web)|window\.|document\.|Date\.now|Math\.random" packages/cash-chase-arena
```

Expected: tests/typecheck pass; forbidden import/global search returns no production matches.

Also run the CCA `format:check`, `lint`, boundary check, and cross-engine parity fixture. Gate 1 cannot exit with a skipped supported engine unless the product support matrix is changed explicitly.

## Gate 2 — browser scaffold, Rallar room, and authority spine

### Task 2.1: Scaffold the app and accessible lobby shell

**Files:**

- Create standard Vite/React app files under `apps/cash-chase-arena/`.
- Create `src/ui/Lobby.tsx`, `Settings.tsx`, `DiagnosticsOverlay.tsx`, and `styles.css`.
- Create `tests/lobby-model.test.ts` and `playwright.config.ts`.
- Modify root workspace scripts only where a named CCA command is useful.

**Test-first steps:**

- [ ] Add model/component tests for signed-out/connecting/room/ready/error states and semantic labels/focus.
- [ ] Add a Playwright smoke test that opens the real lobby, verifies no renderer chunk/canvas is required, and operates visible controls.
- [ ] Implement minimal app shell, error boundary, responsive mobile lobby/spectator message, and hidden diagnostics toggle.
- [ ] Reuse the checked-in CCA Prettier/ESLint configurations and add app `format:check`, `lint`, `typecheck`, `test`, and `build` scripts; include `apps/cash-chase-arena/tests/dependency-boundaries.test.ts` fixtures for raw transport, duplicate election/lease, renderer mutation, and forbidden match authority.
- [ ] Build and measure initial chunks; fail the gate if lobby critical JS exceeds 250 KiB Brotli.

### Task 2.2: Compose Rallar room/session/presence

**Files:**

- Create: `apps/cash-chase-arena/src/rallar/cash-chase-rallar.ts`
- Create: `apps/cash-chase-arena/src/runtime/CashChaseRuntime.ts`
- Create: `apps/cash-chase-arena/tests/rallar-room-runtime.test.ts`

**Consumes:** Existing `rallar`, `GroupRef`, `rooms.createAndSwitch`, `rooms.enter/session`, people/presence and connection status.

**Produces:** One `CashChaseRuntime` with explicit `start`, `createRoom`, `joinRoom`, `leaveRoom`, `setReady`, `status`, `subscribe`, and `dispose` lifecycle.

**Test-first steps:**

- [ ] Test scoped room create/switch, join/session, roster/ready derivation, duplicate active seat, late-join spectator, leave, auth expiry, room switch, stale async completion, typed operational errors, cancellation, and idempotent full disposal using thin Rallar fakes.
- [ ] Implement only public Rallar facade composition; no direct API integration or raw transport.
- [ ] Add visible create/join/leave/ready Playwright flow with resulting room state assertions.

### Task 2.3: Compose Rallar Game browser match

**Files:**

- Create: `apps/cash-chase-arena/src/rallar/cash-chase-protocol.ts`
- Create: `apps/cash-chase-arena/src/rallar/cash-chase-match.ts`
- Create: `apps/cash-chase-arena/src/rallar/cash-chase-diagnostics.ts`
- Create: `apps/cash-chase-arena/tests/rallar-game-match.test.ts`

**Consumes:** `createRallarBrowserMatch`, underlying Rallar Game handle, default game lanes, current appointment policy, roomRef, CCA validators.

**Produces:** capability/election/appointment/readiness, input/intent/snapshot/event/sync, participants/standings, correct room-trusted result.

**Test-first steps:**

- [ ] Test host/backup determinism, elected-only appointment, owner-offline fallback, exact/bounded lane readiness, no fresh director, partial/no-target egress, wrong room/match/sender/epoch/sequence, sync, stop/dispose, and result trust.
- [ ] Assert no CCA `HostLease`, election implementation, lane preset builder, raw transport, or payload-trusted player ID exists.
- [ ] Implement Rallar Game composition and map operator diagnostics into stable UI status.

**Gate 2 validation:** focused CCA tests/build plus existing Rallar Game/room/message/public API tests. Two browser contexts must agree on room, host, backup, epoch, readiness, and disposal.

## Gate 3 — worker, 2D network vertical slice, and Rallar Motion

### Task 3.1: Add the simulation worker bridge

**Files:**

- Create: `apps/cash-chase-arena/src/worker/worker-protocol.ts`
- Create: `apps/cash-chase-arena/src/worker/cash-chase-worker.ts`
- Create: `apps/cash-chase-arena/src/runtime/CashChaseWorkerBridge.ts`
- Create worker tests.

**Test-first steps:**

- [ ] Test versioned init/input/step/pause/resume/snapshot/checkpoint/dispose messages, bounded structured-clone payloads, unsupported versions, invalid message rejection, abort, and stale-generation rejection.
- [ ] Test director and predictor modes, bounded catch-up, background pause, and deterministic hash parity with direct Node simulation.
- [ ] Implement one explicit worker owner; terminate and reject stale generation callbacks on room/logout/unmount/replacement. `stop` and `dispose` remain idempotent after partial initialization.

### Task 3.2: Add input, snapshots, sync, and DOM debug playfield

- [ ] Capture/remap keyboard/mouse into `CashChaseInput`; reset on all UI/lifecycle boundaries.
- [ ] Handle duplicate sessions, late-join spectator mode, disconnect grace, `visibilitychange`, `pagehide/pageshow`, offline/online, and auth expiry without replaying edge actions.
- [ ] Send latest input at 20 Hz through `match.game.sendInput` and apply envelope sender identity in director worker.
- [ ] Publish full snapshots at 12 Hz and reliable critical events/setup/sync through Rallar Game/typed room messages.
- [ ] Render a simple DOM/canvas-2D debug view with player/Sentinel dots, tick, snapshot age, authority, and egress.
- [ ] Complete one two-browser round with one Sentinel, one cash-out, and one mission under induced jitter/loss.

### Task 3.3: Add Rallar Motion presenter

**Files:**

- Create: `apps/cash-chase-arena/src/runtime/CashChaseMotionPresenter.ts`
- Create: `apps/cash-chase-arena/tests/motion-presenter.test.ts`

- [ ] Test receiver-local timing, duplicate/stale rejection, interpolation, bounded extrapolation then hold, confidence/mode, prediction blend/snap, recovery/catch/cash-out discontinuities, entity removal, and disposal.
- [ ] Implement using `RallarMotion`; do not recreate interpolation/correction math.
- [ ] Record snapshot payload, serialize time, GC/allocation, host outbound, tick cadence, and Motion diagnostics in a representative trace.

**Gate 3 exit:** a full two-context debug round passes visible Playwright controls and network assertions; static/performance measurements are recorded before 3D work.

### Task 3.4: Prove migration feasibility before renderer investment

**Files:**

- Create: `packages/tests/shared-web/rallar-game-migration-feasibility.test.ts`
- Create: `apps/cash-chase-arena/docs/migration-feasibility.md`
- Modify only if required for an internal spike: a focused non-public helper under `packages/shared-web/game/`.

**Test-first steps:**

- [ ] Model opaque checkpoint publish-to-elected-backup, validation, acknowledgement, stale pause, one-higher-epoch appointment, promotion callback, restore, recovery commit, and bounded abort using current Rallar Game election, envelope, lane, status, and diagnostics contracts.
- [ ] Add failure cases for no backup, invalid/corrupt checkpoint, missing acknowledgement, director loss at random ticks, promotion failure, old-director return, duplicate recovery commit, and timeout.
- [ ] Prove the promoted state hash equals the acknowledged checkpoint and every old-epoch input/snapshot/event/result is rejected.
- [ ] Run at least 100 deterministic random-tick cases without renderer, React, audio, or CCA transport code.
- [ ] Record required generic public interfaces, bundle impact hypothesis, open Rallar compatibility questions, and whether the 10-second recovery target remains feasible.
- [ ] Remove any throwaway app-local migration implementation; retain only test evidence and deliberately approved internal helper code.

**Gate 3.4 exit:** checkpoint delivery/acknowledgement/promotion/restore and clean abort are feasible using Rallar-owned primitives. If not, stop before renderer work and resolve the Rallar architecture.

## Gate 4 — complete procedural gameplay loop

### Task 4.1: Integrate full deterministic content

- [ ] Create `apps/cash-chase-arena/docs/playtest-protocol.md` with consent, reference build/environment, facilitator script, observation fields, mission-comprehension timing, dominant-strategy evidence, completion/rematch measures, issue severity, and redacted export/deletion handling.
- [ ] Integrate validated fallback arena recipes, 2–8 players, configured Sentinels, all three missions, score/catch/cash-out/spectator/results/rematch.
- [ ] Add `SetupCommit`, `SetupReady`, shared future start tick, late-join/reconnect full sync, and deterministic fallback failure tests.
- [ ] Enforce one active seat per participant, lifecycle grace/leave outcomes, timer-expiry unbanked loss, stable standings tie-break, rematch readiness reset, and host eligibility independent of runner state.
- [ ] Add Rallar Data stores for settings, loadout selection, room recents, and bounded session debug log with schema migration/TTL/validation tests.
- [ ] Prove simulation imports/read paths cannot access Rallar Data and no server CCA data store is opened.

### Task 4.2: Add native audio and semantic HUD

- [ ] Write audio model/voice-cap tests before Web Audio implementation.
- [ ] Add gesture unlock, master/music/SFX/threat buses, mission/interact/dash/caught/cash-out/recovery cues, reduced intensity, mute, and teardown.
- [ ] Add semantic objective/countdown, banked/unbanked score, interaction, threat/link/recovery, results/rematch UI with keyboard/focus and non-color/non-audio redundancy.

**Gate 4 exit:** 2–8 contexts can finish/rematch in the debug presentation; observed users understand objectives; core loop is worth 3D investment.

## Gate 5 — measured renderer selection and integration

Gate 5 may start only after Gate 3.4 proves generic migration feasibility and Gate 4 playtests justify presentation investment.

### Task 5.1: Define renderer adapter and bake-off harness

**Files:**

- Create: `apps/cash-chase-arena/src/renderer/CashChaseRenderer.ts`
- Create bake-off implementations under `src/renderer/renderer-bakeoff/`.
- Create `docs/renderer-bakeoff.md` and renderer lifecycle tests.

- [ ] Implement the exact architecture-document representative scene in direct Three and modular Babylon behind the same adapter.
- [ ] Measure dependency diff, minified/gzip/Brotli, cold first frame, p50/p95 frame, heap/GPU/draw/resource metrics, camera/asset ergonomics, and 20 dispose cycles.
- [ ] Choose the lowest total-risk renderer meeting ≤500 KiB Brotli and runtime budgets; record evidence and remove the losing runtime dependency/implementation.
- [ ] Record the accepted renderer ADR with dependency/license review, lifecycle owner, cache strategy, removal path, and measured evidence.

### Task 5.2: Integrate selected renderer, camera, and characters

- [ ] Render procedural arena, fixed capsule/debug overlay, three silhouettes, six accents/patterns, Sentinels, mission objects, stations, and restrained effects.
- [ ] Implement third-person camera, obstruction, threat assist, camera states, viewport/graphics tiers, and no per-frame React updates.
- [ ] Feed all remote/dynamic transforms from Motion presentation frames.
- [ ] Add renderer mount/load/resize/dispose, nonblank canvas, capsule alignment, camera/HUD/reduced-motion visual tests.
- [ ] Add WebGL context-loss/restore, page lifecycle, reduced graphics, asset-load failure/fallback, and stale renderer-load cancellation tests.

**Gate 5 exit:** bundle, first-frame, frame-time, memory, lifecycle, control, accessibility, and visual QA pass. R3F/Drei/postprocessing remain absent.

## Gate 6 — generic Rallar migration and CCA recovery

### Task 6.1: Specify generic migration interfaces in Rallar Game

**Files likely modified/created:**

- `packages/shared-web/game/types.ts`
- `packages/shared-web/game/match.ts` or a focused `migration.ts`
- `packages/shared-web/game/mod.ts`
- relevant shared contract files only if cross-runtime types are required
- focused tests under `packages/tests/shared-web/`

**Generic interface responsibilities:** checkpoint publish to elected backup, acceptance acknowledgement, stale-director pause, deterministic re-election/appointment, promotion callback, recovery commit, timeout/abort, diagnostics. CCA state remains opaque generic payload.

- [ ] Write public type/API snapshot tests and failing migration state-machine tests first.
- [ ] Reconcile the public design with the Gate 3.4 feasibility evidence; do not preserve a spike shape that duplicates or weakens current Rallar ownership.
- [ ] Implement without breaking existing Rallar Game behavior/imports.
- [ ] Run shared-web typecheck, public API snapshots, browser bundle boundaries, focused Rallar Game tests, and both existing game builds.

### Task 6.2: Integrate CCA checkpoint/restore

- [ ] Send checkpoint on measured cadence and critical events; validate/ack latest tick/revision/hash.
- [ ] Pause on stale authority; re-elect/appoint higher epoch; restore/promote; send recovery commit/full snapshot; resume future tick.
- [ ] Reject returning old director and old epoch inputs/snapshots/events/results.
- [ ] End interrupted without result when recovery exceeds 10 seconds or checkpoint is invalid/missing.

**Gate 6 exit:** at least 9/10 random controlled director-loss runs resume ≤10 seconds with one state/epoch; all other runs end cleanly. Run 100 deterministic migration cases in the test harness.

## Gate 7 — browser, performance, security, and staging hardening

### Task 7.1: Cross-browser and accessibility matrix

- [ ] Add Chromium, Firefox, and WebKit CI projects where flows are supported; add a manual real-Safari/TURN checklist.
- [ ] Test visible auth/create/join/ready/start/move/mission/cash-out/results/rematch/reconnect/migration flows.
- [ ] Test remapping, focus, zoom/HUD scale, reduced motion/intensity, contrast, and color/audio redundancy.
- [ ] Test mixed supported browser pairs, background/foreground, pagehide/pageshow, offline/online, AudioContext interruption, WebGL context loss, stale cached client, and hard-cut protocol refresh.
- [ ] Verify mobile lobby/spectator messaging and block unsupported touch-only active start.

### Task 7.2: Performance/soak gates

- [ ] Measure cold/warm lobby, renderer lazy load, first frame, p50/p95 frame, worker tick, snapshot serialize/bytes, direct/TURN host bandwidth, heap/resources, debug storage, and audio voices.
- [ ] Run 15-minute and 20-round soaks at 2/4/8 players.
- [ ] Profile before optimizing; make one measured change at a time and preserve behavior/public APIs.
- [ ] Store reports under `tmp/perf/`; commit only concise agreed benchmark documentation, not generated profiles.

### Task 7.3: Security/data/deployment review

**Files:**

- Create: `apps/cash-chase-arena/docs/threat-model.md`
- Create: `apps/cash-chase-arena/docs/dependency-and-asset-register.md`
- Create: `apps/cash-chase-arena/docs/staging-runbook.md`
- Create: `apps/cash-chase-arena/docs/release-checklist.md`

- [ ] Validate secrets never appear in client bundle/logs.
- [ ] Test payload/rate/queue/room/prompt/content/storage bounds and escaped player/AI text.
- [ ] Test typed error codes, redacted bounded diagnostics, log byte/entry/TTL caps, duplicate-seat abuse, room removal, and resource-exhaustion cases.
- [ ] Verify room-trusted disclosure and no result after interruption/stale authority.
- [ ] Document HTTPS/WSS, CSP, allowed origins, Rallar server/ICE/TURN/env, health checks, static hosting, cache invalidation, stale-client refresh, rollback, and staging runbook.
- [ ] Review direct/transitive licenses and vulnerabilities; record asset source/license/export/compression/cache metadata and TURN capacity/cost assumptions.
- [ ] Record abuse boundaries for duplicate sessions, room removal, malformed/high-rate traffic, hostile browser director, generated text, local-storage exhaustion, and diagnostic data exposure.
- [ ] Record release build/protocol/browser/renderer/Rallar versions, controlled success target, cache invalidation, feature-disable switches, rollback owner/steps, and unresolved skipped live tests.
- [ ] Add CCA shared-test recipes/artifact analysis for setup, traffic, readiness, reconnect, migration, and failures.

**Gate 7 exit:** all product engineering gates and supported-browser/performance/security/staging checks pass; skipped live requirements are explicitly resolved before release.

## Gate 8 — optional post-core Rallar AI

### Task 8.1: Add server proposal flow only after Gate 7

- [ ] Define strict arena/mission/cosmetic proposal schemas and deterministic domain validators in the pure package.
- [ ] Use current Rallar AI schema/lifecycle/dedupe/governance/mock/evaluation helpers and `createRallarServerAi` with server-only credentials/limits.
- [ ] Test valid, schema-invalid, domain-invalid, stale, duplicate, unauthorized, timeout, unavailable provider, and deterministic fallback.
- [ ] Hard-bound generation so disabling/failing AI never changes startup availability or rules.
- [ ] Do not persist CCA proposals/catalogs server-side; optional bounded local debug replay uses Rallar Data.

## Gate 9 — optional assets and CRDT

- [ ] Add shared-rig GLB/glTF pipeline and dev-only glTF Transform only after procedural character/readability/performance acceptance.
- [ ] Add a Rallar CRDT feature only with a separately approved creator/review product surface.
- [ ] Convert any accepted authored proposal into one validated pre-round setup commit; never feed CRDT state into an active simulation.

## Validation command set

### Every CCA package change

```sh
npx vitest run packages/tests/cash-chase-arena
npm --workspace @ar-eye-hunter/cash-chase-arena run typecheck
npm --workspace @ar-eye-hunter/cash-chase-arena run format:check
npm --workspace @ar-eye-hunter/cash-chase-arena run lint
```

### Every CCA browser change

```sh
npm --workspace cash-chase-arena-app run test
npm --workspace cash-chase-arena-app run typecheck
npm --workspace cash-chase-arena-app run format:check
npm --workspace cash-chase-arena-app run lint
npm --workspace cash-chase-arena-app run build
npx playwright test --config apps/cash-chase-arena/playwright.config.ts
```

### Shared Rallar game/realtime/public surface changes

```sh
npx vitest run packages/tests/shared-web/rallar-game-match.test.ts \
  packages/tests/shared-web/rallar-game-diagnostics.test.ts \
  packages/tests/shared-web/rallar-game-election.test.ts \
  packages/tests/shared-web/rallar-game-lanes.test.ts \
  packages/tests/shared-web/rallar-game-envelopes.test.ts \
  packages/tests/shared-web/rallar-room-realtime-channel.test.ts \
  packages/tests/shared-web/rallar-message-channel-compat.test.ts
npx vitest run packages/tests/shared-web/shared-web-browser-entrypoints.test.ts \
  packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts \
  packages/tests/shared-web/shared-web-public-api-snapshots.test.ts
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-web/tsconfig.json --noEmit
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
npm --workspace ar-eye-hunter-v1 run build
npm --workspace relic-hunters-v1 run build
```

### Full-stack/live gates when services are available

```sh
npm run test:rallar:full-stack:memory:live-rtc-3
npm run test:rallar:full-stack:memory:director
npm run test:shared-black-box:matrix:traffic
npm run test:shared-black-box:matrix:soak
```

If REST behavior changes, add/update `packages/shared-test/black-box-runner` recipes in the same task and run API memory/Postgres black-box commands as applicable.

## MVP done definition

- All Gates 0–7 exit with recorded evidence.
- 2–8 private-room participants can complete and rematch through visible controls.
- Current Rallar public APIs own communication, election, authority, ordering, readiness, fallback, diagnostics, Motion, and local Data.
- Deterministic fallback works without AI/CRDT/assets.
- Exactly three missions, fixed cosmetics, caught/cash-out spectator rules, and room-trusted results behave as specified.
- Migration resumes within 10 seconds in the accepted controlled threshold or ends interrupted without result.
- The non-3D migration spike passes before renderer work, and the later public Rallar migration implementation preserves that evidence with compatibility checks.
- Desktop browser, accessibility, bundle, performance, bandwidth, memory, soak, security, privacy, and staging gates pass.
- Cross-engine canonical hashes, protocol/build compatibility, typed/redacted errors, page/context-loss recovery, dependency/asset review, rollback, and stale-client behavior pass their recorded gates.
- No raw/duplicate framework or forbidden server/local authority path exists.
- Commands run are reported as passed, failed, or skipped with reasons.
