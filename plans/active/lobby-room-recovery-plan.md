# Room Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Return to recent rooms safely in both game consumers.

**Architecture:** Reuse RallarRoomEntry for fresh server admission and tab recovery.
A shared RallarRecentRooms owner persists local history through Rallar Data and
is composed beside the entry owner in each application.

**Tech Stack:** TypeScript, React, Rallar Data/IndexedDB, Vitest, Playwright.

**Spec:** [lobby-room-recovery-design.md](lobby-room-recovery-design.md).

## Global Constraints

- Ten most recently entered distinct scoped references, newest first.
- Store full GroupRef and visit timestamp only; no credentials or availability claims.
- Capture principal for each operation; fresh invitation precedes restored intent.
- Current server admission remains authoritative; no game participation/reset side effect.
- No legacy, duplication, migration, retention changes, or new server write.
- Changed files and recursively changed support files receive full standards closure.
- Maintain one PR, wait for maintainer merge, and remove completed slice plans at handoff.

## Review Focus

- Same-account stop/restart while hydration is outstanding must not close the new store.
- Reentrant entry/auth observers must not record or return for the wrong account.
- Malformed persisted records fail visibly and remain untouched by retries.
- Forgetting the current room must survive unrelated entry notifications.
- Relic returning to a room must not issue Join Expedition or reset activity.

### Task 1: Shared recovery and local history

**Files:**

- Modify `packages/shared-web/browser/rooms/rallar-room-entry.ts` and its existing test.
- Create `packages/shared-web/browser/rooms/recent-rooms/rallar-recent-rooms.ts` and
  `packages/tests/shared-web/rooms/recent-rooms/rallar-recent-rooms.test.ts`.
- Export the new owner through `packages/shared-web/browser/rallar-room-entry.ts`;
  update the existing public API snapshot after inspecting the intentional change.

**Interfaces:**

- `RallarRoomEntry.returnTo(roomRef: GroupRef, principalId: string): Either<Failure, State>`
  validates without replacing intent on failure; successful selection is account-bound,
  code-free and pending. Existing resume controls the network effect.
- `RallarRecentRooms` takes auth, data, entry, injected `now`, and scope; exposes
  `getState`, `onChange`, `start`, `stop`, `retry`, and `forget(roomRef, principalId)`.
  Lifecycle/actions return promises so tests and callers can observe persistence completion.
- State contains principalId, rooms (`roomRef`, `visitedAtEpochMs`), status
  (`signed-out`, `loading`, `ready`, `failed`), and a nullable failure message.
- Both app UIs use `entry.returnTo(visit.roomRef, history.principalId)`; entry
  failures are returned as Either and shown without destroying newer intent.

- [ ] Write bound-return tests for successful code-free admission, account changes,
      scope rejection preserving current destination, denied server entry and fresh-link precedence.
- [ ] Run `npx vitest run packages/tests/shared-web/rooms/rallar-room-entry.test.ts`.
      Expected: new behavior fails because returnTo does not exist; existing 34 tests pass.
- [ ] Implement returnTo with existing validation, persistence and attempt fencing.
- [ ] Add real IndexedDB tests for history ordering/deduplication/cap10/reload/forget,
      auth+scope isolation, no credentials, failure/retry, invalid persisted data,
      late hydration/write completion, same-account restart, and duplicate entry notifications.
- [ ] Run `npx vitest run packages/tests/shared-web/rooms/recent-rooms/rallar-recent-rooms.test.ts`.
      Expected: missing history implementation fails. Implement lifecycle owner using Rallar Data.
- [ ] Run both focused room-entry/history tests and
      `npm run typecheck --workspace @ar-eye-hunter/shared-web`. Expected: exit 0.
- [ ] Commit shared behavior with `feat: add account-scoped recent room recovery` and
      open one draft PR including roadmap progression and design scope.

### Task 2: Both game consumers and delivery

**Files:**

- AR Eye composition `src/game/arena-runtime/arena-room-entry.ts`, connection lifecycle
  `transport/use-arena-connection-session-lifecycle.ts`, and `src/arena-ui/arena-room-entry.tsx`.
- Relic `src/game/relic-hunters-browser.ts`, `relic-hunters-runtime.ts`, and
  `hud/relic-room-entry.tsx`; associated runtime test fixture.
- Existing AR Eye auth lifecycle tests; both games' existing private-room Playwright suites.
- Public API snapshot/boundary tests and browser startup example documentation as needed.
- `docs/product.md`, `docs/architecture.md`, and lobby roadmap for delivered behavior.

**Interfaces:** Consume Task 1's exact entry/history methods. Each composition creates
one history instance. Relic dependencies/connection expose `recentRooms`; AR Eye exports
`arenaRecentRooms`. Start/stop beside entry; history failure remains independently visible.

- [ ] Add lifecycle and rendered-controls tests first: start/stop subscriptions,
      account replacement, Return/Forget interaction, and Relic no automatic Join Expedition.
- [ ] Run affected tests; expected new behavior fails before integration.
- [ ] Compose shared owner and add Recent rooms loading/empty/error/list controls in both UIs.
- [ ] Run affected focused suites and both workspace builds. Expected: exit 0.
- [ ] Run real browser flows proving reload, Return, Forget, fresh-link precedence,
      denied recovery, and Relic activity separation. Expected: all focused cases pass.
- [ ] Run `npm run pr:delivery -- status` before broader checks; repair real conflicts only.
- [ ] Run shared-web public API/entrypoint tests, browser bundle boundaries, applicable
      package/app suites and repo style/structure checks. Expected: pass or explicitly assessed
      warning-only findings with no retained touched-file violation.
- [ ] Commit consumer behavior and docs, update PR, request fresh whole-branch review,
      resolve actionable findings through RED/GREEN tests, and inspect required CI.
- [ ] Remove completed slice plan/design in the delivery commit; leave the roadmap current.
      Run `npm run pr:delivery -- ready` once (do not merge or enable auto-merge).
      Hand off the PR and wait for maintainer merge before retention planning.
