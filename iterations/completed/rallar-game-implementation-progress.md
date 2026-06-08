# Rallar Game Implementation Progress

Date: 2026-06-08

## Goal

Implement the Rallar Game V1 plan from
`plans/rallar-game-product-and-implementation-plan.md` as a browser-side,
generic match orchestration layer under `packages/shared-web/game`.

## Audit Checklist

- [x] Read Rallar API, quickstart, AI skill, troubleshooting, product
      evaluation, and existing implementation progress docs relevant to browser
      Rallar, RTC, realtime lanes, director relay, and public facade boundaries.
- [x] Read Cash Chase Arena planning docs relevant to Rallar-only networking,
      browser-hosted authority, controls, snapshots, and app/runtime separation.
- [x] Inspected root and shared-web package scripts.
- [x] Inspected `packages/shared-web/browser/rallar.ts`,
      `packages/shared-web/browser/middleware.ts`,
      `packages/shared/services/WebRtcConnectionService.ts`,
      `packages/shared-web/mod.ts`, and current shared-web tests.
- [x] Confirmed Rallar Game must compose public facade APIs only and must not
      call `advanced.middleware()` or create raw browser networking objects.

## Milestones

### 1. Pure API And Helper Slice

- [x] Add public Rallar Game types.
- [x] Add lane preset builder.
- [x] Add envelope helpers and sequence tracker.
- [x] Add deterministic host scoring and election.
- [x] Add diagnostics aggregation.
- [x] Add focused unit tests for pure helpers.
- [x] Verify focused pure-helper tests.

### 2. Match Orchestration Slice

- [x] Add `createRallarGameMatch(...)` over the minimal Rallar facade pick.
- [x] Subscribe to room, people, director, RTC, capability, realtime input,
      realtime snapshot, and director relay surfaces on start.
- [x] Implement capability reporting, election, appoint-if-elected, lane
      readiness, send input, send intent, publish snapshot, publish event,
      request sync, diagnostics, status, and stop cleanup.
- [x] Add fake-Rallar match tests.
- [x] Verify focused match tests.

### 3. Export And Product Docs Slice

- [x] Export `packages/shared-web/game/mod.ts`.
- [x] Export Rallar Game from `packages/shared-web/mod.ts`.
- [x] Keep the Cash Chase consumption notes in the plan current.
- [x] Verify shared-web typecheck/build.

### 3.5 Cash Chase Runtime Wiring

- [x] Document Cash Chase consumption shape in
      `plans/rallar-game-product-and-implementation-plan.md`.
- [x] Defer Cash Chase-specific runtime wiring until a concrete
      `apps/cash-chase-arena` and/or `packages/cash-chase-core` runtime exists.
      Current repo state has planning docs under `projects/cash-chase-arena`,
      but no Cash Chase app/runtime package to wire without creating a larger
      product scaffold outside this Rallar Game plan.

### 4. Completion Audit

- [x] Confirm no raw `WebSocket`, `RTCPeerConnection`, or DataChannel creation
      exists in `packages/shared-web/game`.
- [x] Confirm no calls to `rallar.advanced.middleware()` exist in
      `packages/shared-web/game`.
- [x] Confirm no simulation, rendering, scoring, movement, combat, missions, or
      AI logic was added to Rallar Game.
- [x] Confirm all public types are generic and Cash Chase-neutral.
- [x] Confirm relevant tests pass.

## Verified

- `npx vitest run packages/tests/shared-web/rallar-game-lanes.test.ts packages/tests/shared-web/rallar-game-envelopes.test.ts packages/tests/shared-web/rallar-game-election.test.ts packages/tests/shared-web/rallar-game-diagnostics.test.ts`
  passed: 4 files, 14 tests.
- `npm --workspace @ar-eye-hunter/shared-web run typecheck` passed after the
  pure API/helper slice.
- `npx vitest run packages/tests/shared-web/rallar-game*.test.ts` passed:
  5 files, 23 tests.
- `npm --workspace @ar-eye-hunter/shared-web run build` passed after the match
  orchestration and export slices.
- `npx vitest run packages/tests/shared-web/*.test.ts` passed: 15 files,
  195 tests.
- `npm run build` passed across workspaces. Vite reported chunk-size warnings
  only.
- `rg -n "new WebSocket|RTCPeerConnection|createDataChannel|advanced\\.middleware\\(|movement|combat|scoring|missions|Sentinel|simulation|render" packages/shared-web/game`
  returned no matches.

## Remaining Limitations

- Cash Chase-specific runtime wiring is not implemented because the repo
  currently has planning docs for Cash Chase, but no Cash Chase app/runtime
  package to wire against. The new generic API is ready for that future slice.
- V1 recovery is pause/re-elect/request-sync/snapshot oriented. Full seamless
  host migration and continuous backup-state promotion remain deferred, as
  required by the plan.
