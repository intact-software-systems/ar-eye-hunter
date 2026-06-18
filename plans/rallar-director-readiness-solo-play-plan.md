# Rallar Director Readiness And Solo Play Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Distinguish local director authority, reliable group presence readiness, and realtime RTC lane readiness so AR Eye Hunter can play solo immediately while safely syncing late-joining peers without send-before-open RTC failures.

**Architecture:** Rallar owns generic room presence expectations, RTC lane expectation evaluation, and typed transport not-ready outcomes. Rallar Game exposes local authority and network egress readiness separately, while AR Eye Hunter consumes those states to keep the solo director active and to start reliable/realtime peer communication only when the matching transport is ready or explicitly overridden.

**Tech Stack:** TypeScript, Rallar shared/shared-web facades, AL outbound runtime, WebRTC data channels, React/Vite AR Eye Hunter, Vitest, Playwright/Vite builds.

---

## Design Decisions

- Reliable readiness is presence-based: `rallar.rooms.waitForPresence(...)` counts active group sessions, including the local session. A solo room creator satisfies `expect: { min: 1 }`.
- Realtime readiness is RTC-lane-based: `rallar.rtc.waitForRoomLane(...)` counts remote open data channels. A solo director with zero remote peers returns `empty`, not failure.
- `waitForPresence` and `waitForRoomLane` both accept the same expectation shape: `{ min, max }`, `{ exact }`, or `{ sessionIds, allowExtras }`.
- Reliable group communication can wait for the expected presence set, then continue after timeout only when the caller asks for override behavior.
- Best-effort RTC traffic sends only to peers with open lanes. Missing or warming RTC channels produce typed `not-ready` or `no-targets` outcomes instead of raw `Data channel not open` errors.
- AR Eye Hunter owns game policy: auto-created rooms appoint the creator as director, allow immediate solo play, and sync new peers as they become present/open.

## File Map

- Create: `packages/shared-web/browser/readiness.ts` for shared expectation validation and count/session-id evaluation.
- Modify: `packages/shared-web/browser/rallar.ts` to export readiness types, add `rooms.waitForPresence(...)`, extend `rtc.waitForRoomLane(...)`, and adjust director relay fallback behavior.
- Modify: `packages/shared-web/browser/rallar-rooms-facade.ts` to expose `waitForPresence`.
- Use: `packages/shared-web/browser/data-caches.ts` as the existing `onStateCacheChange(...)` notification source for presence waits.
- Modify: `packages/shared/alm/ALOutboundMessageRuntime.ts` to accept typed prepared-send outcomes and reschedule `not-ready` effects without treating them as hard failures.
- Modify: `packages/shared/multicast/WebRtcOverlayMulticastManager.ts` to return typed `no-targets` and `not-ready` results before calling raw RTC sends.
- Modify: `packages/shared/services/WsQueueBoxClientService.ts` and `packages/shared/services/WsQueueBoxServerService.ts` to keep the new `sendPreparedMessage` contract source-compatible by returning `sent`.
- Modify: `packages/shared-web/game/types.ts`, `packages/shared-web/game/match.ts`, and `packages/shared-web/game/diagnostics.ts` to separate authority from egress readiness.
- Modify: `apps/ar-eye-hunter-v1/src/game/useRallarArena.ts` to keep local director/server behavior active before remote RTC readiness and to trigger peer sync after readiness changes.
- Modify: `apps/ar-eye-hunter-v1/src/App.tsx` to show director authority, reliable egress, and realtime egress separately.
- Test: `packages/tests/shared-web/rallar-readiness.test.ts`
- Test: `packages/tests/shared-web/rallar-rtc-wait-compat.test.ts`
- Test: `packages/tests/shared-web/rallar-director-relay-compat.test.ts`
- Test: `packages/tests/shared-web/rallar-game-match.test.ts`
- Test: `packages/tests/shared/al-outbound-message-runtime.test.ts`
- Test: `packages/tests/shared/multicast-policy-integration.test.ts`
- Test: `packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts`
- Test: `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`

## Public Semantics

```ts
export type RallarReadinessExpectation =
    | Readonly<{ min: number; max?: number }>
    | Readonly<{ exact: number }>
    | Readonly<{ sessionIds: readonly string[]; allowExtras?: boolean }>;

export type RallarReadinessStatus =
    | 'ready'
    | 'partial'
    | 'empty'
    | 'timeout'
    | 'over-capacity'
    | 'aborted'
    | 'not-found'
    | 'not-connected';
```

- `min` means ready when observed count is at least `min`; `max` turns counts above `max` into `over-capacity`.
- `exact` means ready only when observed count equals `exact`.
- `sessionIds` means ready when all listed sessions are present/open; `allowExtras` defaults to `true`.
- `empty` is valid when the expected count is zero or when RTC has no remote targets for a solo room.
- `timeout` includes the latest observed set so callers can decide whether to override and continue.

## Execution Safety

- Before each commit step, run `git status --short` and `git diff -- <listed files>` for the files in that task.
- When a listed file already contains unrelated local edits, stage only the hunks produced by the current task with `git add -p <listed files>` or skip the task commit and report the overlap.
- Do not stage broad directories such as `packages/shared` or `apps/ar-eye-hunter-v1`; this repository often has unrelated work in progress.

## Tasks

### Task 1: Add Readiness Expectation Helpers

**Files:**
- Create: `packages/shared-web/browser/readiness.ts`
- Test: `packages/tests/shared-web/rallar-readiness.test.ts`
- Modify: `packages/shared-web/browser/rallar.ts`
- Test: `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`

- [ ] **Step 1: Write expectation helper tests**

Create `packages/tests/shared-web/rallar-readiness.test.ts` with these behavioral cases:

```ts
import { describe, expect, it } from 'vitest';
import {
    evaluateRallarReadinessExpectation,
    normalizeRallarReadinessExpectation,
} from '@shared-web/browser/rallar.ts';

describe('Rallar readiness expectations', () => {
    it('treats one active local session as ready for min one', () => {
        const result = evaluateRallarReadinessExpectation(
            ['session-local'],
            normalizeRallarReadinessExpectation({ min: 1 }),
        );

        expect(result).toMatchObject({
            status: 'ready',
            observedCount: 1,
            missingSessionIds: [],
            extraSessionIds: [],
        });
    });

    it('reports partial when exact count is not reached', () => {
        const result = evaluateRallarReadinessExpectation(
            ['session-local'],
            normalizeRallarReadinessExpectation({ exact: 2 }),
        );

        expect(result.status).toBe('partial');
        expect(result.observedCount).toBe(1);
        expect(result.expectedCount).toBe(2);
    });

    it('reports over-capacity when exact count is exceeded', () => {
        const result = evaluateRallarReadinessExpectation(
            ['a', 'b', 'c'],
            normalizeRallarReadinessExpectation({ exact: 2 }),
        );

        expect(result.status).toBe('over-capacity');
        expect(result.extraSessionIds).toEqual(['c']);
    });

    it('waits for expected session ids and allows extras by default', () => {
        const result = evaluateRallarReadinessExpectation(
            ['director', 'player', 'spectator'],
            normalizeRallarReadinessExpectation({
                sessionIds: ['director', 'player'],
            }),
        );

        expect(result.status).toBe('ready');
        expect(result.extraSessionIds).toEqual(['spectator']);
    });

    it('reports over-capacity for strict session id expectations', () => {
        const result = evaluateRallarReadinessExpectation(
            ['director', 'player', 'spectator'],
            normalizeRallarReadinessExpectation({
                sessionIds: ['director', 'player'],
                allowExtras: false,
            }),
        );

        expect(result.status).toBe('over-capacity');
        expect(result.extraSessionIds).toEqual(['spectator']);
    });
});
```

- [ ] **Step 2: Run the new tests and verify the missing exports**

Run: `npx vitest run packages/tests/shared-web/rallar-readiness.test.ts`

Expected: FAIL with import errors for `evaluateRallarReadinessExpectation` and `normalizeRallarReadinessExpectation`.

- [ ] **Step 3: Implement the readiness helper**

Create `packages/shared-web/browser/readiness.ts` with the exported types and helper functions:

```ts
export type RallarReadinessExpectation =
    | Readonly<{ min: number; max?: number }>
    | Readonly<{ exact: number }>
    | Readonly<{ sessionIds: readonly string[]; allowExtras?: boolean }>;

export type RallarNormalizedReadinessExpectation = Readonly<{
    min?: number;
    max?: number;
    exact?: number;
    sessionIds?: readonly string[];
    allowExtras: boolean;
}>;

export type RallarReadinessStatus =
    | 'ready'
    | 'partial'
    | 'empty'
    | 'timeout'
    | 'over-capacity'
    | 'aborted'
    | 'not-found'
    | 'not-connected';

export type RallarReadinessEvaluation = Readonly<{
    status: RallarReadinessStatus;
    observedSessionIds: readonly string[];
    missingSessionIds: readonly string[];
    extraSessionIds: readonly string[];
    observedCount: number;
    expectedCount?: number;
}>;

export function normalizeRallarReadinessExpectation(
    expectation: RallarReadinessExpectation | undefined,
): RallarNormalizedReadinessExpectation {
    if (!expectation) {
        return { min: 1, allowExtras: true };
    }

    if ('sessionIds' in expectation) {
        return {
            sessionIds: uniqueSortedSessionIds(expectation.sessionIds),
            allowExtras: expectation.allowExtras ?? true,
        };
    }

    if ('exact' in expectation) {
        return {
            exact: normalizeNonNegativeInteger(expectation.exact, 'exact'),
            allowExtras: false,
        };
    }

    const min = normalizeNonNegativeInteger(expectation.min, 'min');
    const max = expectation.max === undefined
        ? undefined
        : normalizeNonNegativeInteger(expectation.max, 'max');
    if (max !== undefined && max < min) {
        throw new Error('Rallar readiness expectation max must be greater than or equal to min.');
    }

    return { min, max, allowExtras: true };
}

export function evaluateRallarReadinessExpectation(
    observedSessionIds: readonly string[],
    expectation: RallarNormalizedReadinessExpectation,
): RallarReadinessEvaluation {
    const observed = uniqueSortedSessionIds(observedSessionIds);
    const observedSet = new Set(observed);
    const expectedSessionIds = expectation.sessionIds ?? [];
    const missingSessionIds = expectedSessionIds
        .filter((sessionId) => !observedSet.has(sessionId));
    const expectedSet = new Set(expectedSessionIds);
    const extraSessionIds = expectedSessionIds.length === 0
        ? observed.slice(readExpectedCount(expectation) ?? observed.length)
        : observed.filter((sessionId) => !expectedSet.has(sessionId));

    if (expectation.sessionIds) {
        if (missingSessionIds.length > 0) {
            return toEvaluation('partial', observed, missingSessionIds, extraSessionIds, expectation.sessionIds.length);
        }
        if (!expectation.allowExtras && extraSessionIds.length > 0) {
            return toEvaluation('over-capacity', observed, missingSessionIds, extraSessionIds, expectation.sessionIds.length);
        }
        return toEvaluation(observed.length === 0 ? 'empty' : 'ready', observed, missingSessionIds, extraSessionIds, expectation.sessionIds.length);
    }

    if (expectation.exact !== undefined) {
        if (observed.length === expectation.exact) {
            return toEvaluation(expectation.exact === 0 ? 'empty' : 'ready', observed, [], [], expectation.exact);
        }
        if (observed.length > expectation.exact) {
            return toEvaluation('over-capacity', observed, [], observed.slice(expectation.exact), expectation.exact);
        }
        return toEvaluation('partial', observed, [], [], expectation.exact);
    }

    const min = expectation.min ?? 1;
    if (expectation.max !== undefined && observed.length > expectation.max) {
        return toEvaluation('over-capacity', observed, [], observed.slice(expectation.max), min);
    }
    if (observed.length >= min) {
        return toEvaluation(min === 0 && observed.length === 0 ? 'empty' : 'ready', observed, [], [], min);
    }
    return toEvaluation(observed.length === 0 ? 'empty' : 'partial', observed, [], [], min);
}

function readExpectedCount(
    expectation: RallarNormalizedReadinessExpectation,
): number | undefined {
    return expectation.exact ?? expectation.min ?? expectation.sessionIds?.length;
}

function toEvaluation(
    status: RallarReadinessStatus,
    observedSessionIds: readonly string[],
    missingSessionIds: readonly string[],
    extraSessionIds: readonly string[],
    expectedCount?: number,
): RallarReadinessEvaluation {
    return {
        status,
        observedSessionIds,
        missingSessionIds,
        extraSessionIds,
        observedCount: observedSessionIds.length,
        expectedCount,
    };
}

function uniqueSortedSessionIds(sessionIds: readonly string[]): readonly string[] {
    return [...new Set(sessionIds)].sort((left, right) => left.localeCompare(right));
}

function normalizeNonNegativeInteger(value: number, name: string): number {
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`Rallar readiness expectation ${name} must be a non-negative integer.`);
    }
    return value;
}
```

Modify `packages/shared-web/browser/rallar.ts` to export the helper API:

```ts
export {
    evaluateRallarReadinessExpectation,
    normalizeRallarReadinessExpectation,
} from '@shared-web/browser/readiness.ts';

export type {
    RallarNormalizedReadinessExpectation,
    RallarReadinessEvaluation,
    RallarReadinessExpectation,
    RallarReadinessStatus,
} from '@shared-web/browser/readiness.ts';
```

- [ ] **Step 4: Run helper and public API tests**

Run: `npx vitest run packages/tests/shared-web/rallar-readiness.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`

Expected: PASS after updating the public API snapshot fixture in the snapshot test output.

- [ ] **Step 5: Commit Task 1**

Run:

```bash
git add packages/shared-web/browser/readiness.ts packages/shared-web/browser/rallar.ts packages/tests/shared-web/rallar-readiness.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts
git commit -m "feat: add rallar readiness expectation helpers"
```

Expected: commit succeeds.

### Task 2: Add `rallar.rooms.waitForPresence`

**Files:**
- Modify: `packages/shared-web/browser/rallar.ts`
- Modify: `packages/shared-web/browser/rallar-rooms-facade.ts`
- Test: `packages/tests/shared-web/rallar-readiness.test.ts`

- [ ] **Step 1: Add failing room presence wait tests**

Extend `packages/tests/shared-web/rallar-readiness.test.ts` with facade-level tests using the existing shared-web facade mock pattern from `packages/tests/shared-web/rallar-rtc-wait-compat.test.ts`:

```ts
it('waits for local room presence with min one for solo rooms', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const facade = createRallarFacade();

    await facade.connect();
    seedGroupSnapshot({
        groupId: 'arena-1',
        activeSessionIds: ['session-local'],
    });

    await expect(facade.rooms.waitForPresence('arena-1', {
        expect: { min: 1 },
        timeoutMs: 10,
    })).resolves.toMatchObject({
        status: 'ready',
        activeSessionIds: ['session-local'],
        observedCount: 1,
    });
});

it('returns timeout with the latest active sessions when exact presence is not reached', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const facade = createRallarFacade();

    await facade.connect();
    seedGroupSnapshot({
        groupId: 'arena-1',
        activeSessionIds: ['session-local'],
    });

    await expect(facade.rooms.waitForPresence('arena-1', {
        expect: { exact: 2 },
        timeoutMs: 1,
    })).resolves.toMatchObject({
        status: 'timeout',
        activeSessionIds: ['session-local'],
        observedCount: 1,
        expectedCount: 2,
    });
});

it('resolves when a later state cache update satisfies presence expectations', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const facade = createRallarFacade();

    await facade.connect();
    seedGroupSnapshot({
        groupId: 'arena-1',
        activeSessionIds: ['session-local'],
    });

    const wait = facade.rooms.waitForPresence('arena-1', {
        expect: { exact: 2 },
        timeoutMs: 1_000,
    });

    seedGroupSnapshot({
        groupId: 'arena-1',
        activeSessionIds: ['session-local', 'session-peer'],
    });

    await expect(wait).resolves.toMatchObject({
        status: 'ready',
        activeSessionIds: ['session-local', 'session-peer'],
        observedCount: 2,
    });
});
```

The `seedGroupSnapshot(...)` helper should build a `GroupSnapshot` with active members, call `groupStateSnapshotsRepository.setGroupStateSnapshots([snapshot])`, then await `groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle()`. Keep the helper inside the test file.

- [ ] **Step 2: Run the presence tests and verify missing facade API**

Run: `npx vitest run packages/tests/shared-web/rallar-readiness.test.ts`

Expected: FAIL with `waitForPresence` missing from `facade.rooms`.

- [ ] **Step 3: Add room presence option/result types**

In `packages/shared-web/browser/rallar.ts`, add public types beside the room and wait types:

```ts
export type RallarRoomPresenceWaitOptions =
    & RallarScopedOperationOptions
    & Readonly<{
    expect?: RallarReadinessExpectation;
    timeoutMs?: number;
    signal?: AbortSignal;
}>;

export type RallarRoomPresenceWaitResult =
    & RallarReadinessEvaluation
    & Readonly<{
    roomId: string;
    roomRef?: GroupRef;
    activeSessionIds: readonly string[];
    timedOut: boolean;
}>;
```

Import the helper functions in `rallar.ts` for internal use:

```ts
import {
    evaluateRallarReadinessExpectation,
    normalizeRallarReadinessExpectation,
    type RallarReadinessExpectation,
    type RallarReadinessEvaluation,
    type RallarReadinessStatus,
} from '@shared-web/browser/readiness.ts';
```

- [ ] **Step 4: Expose the method through the rooms facade**

Modify `packages/shared-web/browser/rallar-rooms-facade.ts` imports from `rallar.ts`:

```ts
import type {
    RallarRoomPresenceWaitOptions,
    RallarRoomPresenceWaitResult,
} from '@shared-web/browser/rallar.ts';
```

Add to `RallarRoomsFacade`:

```ts
waitForPresence(
    room: string | GroupRef,
    options?: RallarRoomPresenceWaitOptions,
): Promise<RallarRoomPresenceWaitResult>;
```

Add to `createRallarRoomsFacade(...)`:

```ts
waitForPresence: async (
    room,
    options: RallarRoomPresenceWaitOptions = {},
): Promise<RallarRoomPresenceWaitResult> =>
    await operations.waitForPresence(room, options),
```

Wire it in the `readonly rooms` initializer in `packages/shared-web/browser/rallar.ts`:

```ts
waitForPresence: async (room, options) =>
    await this.waitForRoomPresence(room, options),
```

- [ ] **Step 5: Implement the wait loop**

Add `private async waitForRoomPresence(...)` in `packages/shared-web/browser/rallar.ts` near other room methods:

```ts
private async waitForRoomPresence(
    room: string | GroupRef,
    options: RallarRoomPresenceWaitOptions = {},
): Promise<RallarRoomPresenceWaitResult> {
    const operationOptions = this.resolveOperationOptions(options);
    const roomId = this.toRoomId(room);
    const roomRef = typeof room === 'string'
        ? this.resolveGroupRefFromRoomId(roomId, options.scope) ?? this.resolveRoomRef(room)
        : room;
    const expectation = normalizeRallarReadinessExpectation(options.expect);

    const readResult = (statusOverride?: RallarReadinessStatus): RallarRoomPresenceWaitResult => {
        const snapshot = this.findGroupSnapshot(roomRef ?? room);
        if (!snapshot || !isGroupActive(snapshot)) {
            const empty = evaluateRallarReadinessExpectation([], expectation);
            return {
                ...empty,
                status: statusOverride ?? 'not-found',
                roomId,
                roomRef: roomRef ?? undefined,
                activeSessionIds: [],
                timedOut: statusOverride === 'timeout',
            };
        }

        const activeSessionIds = [...new Set(
            snapshot.activeSessions.map((session) => session.sessionId),
        )].sort((left, right) => left.localeCompare(right));
        const evaluation = evaluateRallarReadinessExpectation(activeSessionIds, expectation);
        return {
            ...evaluation,
            status: statusOverride ?? evaluation.status,
            roomId,
            roomRef: snapshot.group,
            activeSessionIds,
            timedOut: statusOverride === 'timeout',
        };
    };

    const current = readResult();
    if (current.status === 'ready' || current.status === 'empty' || current.status === 'over-capacity') {
        return current;
    }

    if (operationOptions.signal?.aborted) {
        return { ...current, status: 'aborted' };
    }

    const timeoutMs = normalizeWaitTimeoutMs(options.timeoutMs);
    if (timeoutMs <= 0) {
        return readResult('timeout');
    }

    return await new Promise<RallarRoomPresenceWaitResult>((resolve) => {
        let settled = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let unsubscribe: RallarUnsubscribe = () => {};

        const finish = (result: RallarRoomPresenceWaitResult): void => {
            if (settled) {
                return;
            }
            settled = true;
            if (timeout !== undefined) {
                clearTimeout(timeout);
            }
            operationOptions.signal?.removeEventListener('abort', onAbort);
            unsubscribe();
            resolve(result);
        };

        const onAbort = (): void => finish({
            ...readResult(),
            status: 'aborted',
        });

        unsubscribe = stateCaches.onStateCacheChange(() => {
            const next = readResult();
            if (next.status === 'ready' || next.status === 'empty' || next.status === 'over-capacity') {
                finish(next);
            }
        });
        operationOptions.signal?.addEventListener('abort', onAbort, { once: true });
        timeout = setTimeout(() => finish(readResult('timeout')), timeoutMs);
    });
}
```

- [ ] **Step 6: Run focused presence tests**

Run: `npx vitest run packages/tests/shared-web/rallar-readiness.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

Run:

```bash
git add packages/shared-web/browser/rallar.ts packages/shared-web/browser/rallar-rooms-facade.ts packages/tests/shared-web/rallar-readiness.test.ts
git commit -m "feat: add room presence readiness waits"
```

Expected: commit succeeds.

### Task 3: Extend `rallar.rtc.waitForRoomLane` With Expectations

**Files:**
- Modify: `packages/shared-web/browser/rallar.ts`
- Test: `packages/tests/shared-web/rallar-rtc-wait-compat.test.ts`

- [ ] **Step 1: Add failing RTC expectation tests**

Extend `packages/tests/shared-web/rallar-rtc-wait-compat.test.ts` with these cases:

```ts
it('returns empty for a solo room with no remote RTC targets', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const facade = createRallarFacade();

    await facade.connect();
    seedGroupSnapshot({
        groupId: 'arena-1',
        activeSessionIds: ['session-local'],
    });

    await expect(facade.rtc.waitForRoomLane('arena-1', 'game-snapshot', {
        expect: { exact: 0 },
        timeoutMs: 10,
    })).resolves.toMatchObject({
        status: 'empty',
        readyPeerIds: [],
        notReadyPeerIds: [],
        expectedCount: 0,
    });
});

it('waits until the expected number of remote peers have open lanes', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const facade = createRallarFacade();

    await facade.connect();
    seedGroupSnapshot({
        groupId: 'arena-1',
        activeSessionIds: ['session-local', 'peer-1', 'peer-2'],
    });
    mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue(['peer-1']);

    await expect(facade.rtc.waitForRoomLane('arena-1', 'game-snapshot', {
        expect: { exact: 2 },
        timeoutMs: 1,
    })).resolves.toMatchObject({
        status: 'timeout',
        readyPeerIds: ['peer-1'],
        notReadyPeerIds: ['peer-2'],
        expectedCount: 2,
    });
});

it('supports strict expected peer session ids', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const facade = createRallarFacade();

    await facade.connect();
    seedGroupSnapshot({
        groupId: 'arena-1',
        activeSessionIds: ['session-local', 'peer-1', 'peer-2'],
    });
    mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue(['peer-1', 'peer-2']);

    await expect(facade.rtc.waitForRoomLane('arena-1', 'game-snapshot', {
        expect: { sessionIds: ['peer-1'], allowExtras: false },
        timeoutMs: 10,
    })).resolves.toMatchObject({
        status: 'over-capacity',
        readyPeerIds: ['peer-1', 'peer-2'],
        extraPeerIds: ['peer-2'],
    });
});
```

- [ ] **Step 2: Run RTC wait tests and verify missing fields**

Run: `npx vitest run packages/tests/shared-web/rallar-rtc-wait-compat.test.ts`

Expected: FAIL because `RallarRtcRoomLaneWaitOptions` has no `expect`, and result objects lack count/session-id fields.

- [ ] **Step 3: Extend RTC wait types**

Modify `RallarRtcRoomLaneWaitOptions` in `packages/shared-web/browser/rallar.ts`:

```ts
export type RallarRtcRoomLaneWaitOptions =
    & RallarWaitForOpenOptions
    & Readonly<{
    connect?: boolean;
    roomRef?: GroupRef;
    expect?: RallarReadinessExpectation;
}>;
```

Extend `RallarRtcRoomLaneWaitResult`:

```ts
export type RallarRtcRoomLaneWaitResult = Readonly<{
    transport: 'rtc';
    roomId: string;
    laneId: string;
    status: RallarRtcRoomLaneWaitStatus;
    rtcStatus: RallarRtcStatus;
    ready: readonly RallarRtcWaitForOpenResult[];
    notReady: readonly RallarRtcWaitForOpenResult[];
    readyPeerIds: readonly string[];
    notReadyPeerIds: readonly string[];
    missingPeerIds: readonly string[];
    extraPeerIds: readonly string[];
    observedCount: number;
    expectedCount?: number;
}>;
```

Add `'over-capacity'` to `RallarRtcRoomLaneWaitStatus`.

- [ ] **Step 4: Implement expectation-aware RTC room lane wait**

Update `waitForRtcRoomLaneOpen(...)` in `packages/shared-web/browser/rallar.ts`:

```ts
const desiredPeerIds = this.resolveRoomPeerIds(options.roomRef ?? room);
const expectation = normalizeRallarReadinessExpectation(
    options.expect ?? { exact: desiredPeerIds.length },
);
if (desiredPeerIds.length === 0) {
    return this.toRtcRoomLaneWaitResult(roomId, laneId, [], [], expectation);
}
```

After lane wait results are collected, pass the expectation into `toRtcRoomLaneWaitResult(...)`.

Update `toRtcRoomLaneWaitResult(...)` to evaluate ready peer IDs:

```ts
private toRtcRoomLaneWaitResult(
    roomId: string,
    laneId: string,
    ready: readonly RallarRtcWaitForOpenResult[],
    notReady: readonly RallarRtcWaitForOpenResult[],
    expectation: RallarNormalizedReadinessExpectation,
): RallarRtcRoomLaneWaitResult {
    const readyPeerIds = ready.map((result) => result.peerId)
        .sort((left, right) => left.localeCompare(right));
    const notReadyPeerIds = notReady.map((result) => result.peerId)
        .sort((left, right) => left.localeCompare(right));
    const evaluation = evaluateRallarReadinessExpectation(readyPeerIds, expectation);
    const waitStatus = toRtcRoomLaneWaitStatus(ready, notReady);
    const status = evaluation.status === 'ready' || evaluation.status === 'empty' || evaluation.status === 'over-capacity'
        ? evaluation.status
        : waitStatus;

    return {
        transport: 'rtc',
        roomId,
        laneId,
        status,
        rtcStatus: this.toRtcStatus({ laneId }),
        ready,
        notReady,
        readyPeerIds,
        notReadyPeerIds,
        missingPeerIds: evaluation.missingSessionIds,
        extraPeerIds: evaluation.extraSessionIds,
        observedCount: evaluation.observedCount,
        expectedCount: evaluation.expectedCount,
    };
}
```

Keep old callers source-compatible by defaulting `expect` to the current desired remote peer count.

- [ ] **Step 5: Run RTC wait tests**

Run: `npx vitest run packages/tests/shared-web/rallar-rtc-wait-compat.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

Run:

```bash
git add packages/shared-web/browser/rallar.ts packages/tests/shared-web/rallar-rtc-wait-compat.test.ts
git commit -m "feat: add expected rtc room lane readiness"
```

Expected: commit succeeds.

### Task 4: Convert RTC Prepared Send Warm-Up Failures Into Typed Outcomes

**Files:**
- Modify: `packages/shared/alm/ALOutboundMessageRuntime.ts`
- Modify: `packages/shared/multicast/WebRtcOverlayMulticastManager.ts`
- Modify: `packages/shared/services/WsQueueBoxClientService.ts`
- Modify: `packages/shared/services/WsQueueBoxServerService.ts`
- Test: `packages/tests/shared/al-outbound-message-runtime.test.ts`
- Test: `packages/tests/shared/multicast-policy-integration.test.ts`

- [ ] **Step 1: Add failing AL runtime tests for typed prepared-send results**

Extend `packages/tests/shared/al-outbound-message-runtime.test.ts`:

```ts
it('reschedules durable send-prepared effects when the transport is not ready', async () => {
    const sendPreparedMessage = vi.fn(async () => ({
        status: 'not-ready' as const,
        reason: 'RTC lane warming',
        retryAfterMs: 25,
    }));
    const runtime = createRuntime({ sendPreparedMessage });

    await runtime.dispatch(createMessage('msg-1'));
    await drainEffects(runtime);

    expect(sendPreparedMessage).toHaveBeenCalled();
    expect(await readCompletedEffectCount(runtime)).toBe(0);
    expect(await readPendingEffectCount(runtime)).toBe(1);
});

it('completes durable send-prepared effects when there are no RTC targets', async () => {
    const sendPreparedMessage = vi.fn(async () => ({
        status: 'no-targets' as const,
        reason: 'solo room',
    }));
    const runtime = createRuntime({ sendPreparedMessage });

    await runtime.dispatch(createMessage('msg-1'));
    await drainEffects(runtime);

    expect(sendPreparedMessage).toHaveBeenCalled();
    expect(await readPendingEffectCount(runtime)).toBe(0);
});
```

Use the existing runtime helper names in this test file; keep the assertions equivalent if helper names differ.

- [ ] **Step 2: Add failing multicast test for closed channel preflight**

Extend `packages/tests/shared/multicast-policy-integration.test.ts`:

```ts
it('does not call raw RTC send when the next-hop channel is not open', async () => {
    const channel = createMockRtcChannel({
        readyState: 'connecting',
        send: vi.fn(async () => {
            throw new Error('Data channel not open');
        }),
    });
    const manager = createMulticastManagerWithPeer('peer-1', channel);

    const result = await manager.sendPreparedMessageForTest(
        createPreparedMessageForPeer('peer-1'),
        'dequeue',
    );

    expect(result).toMatchObject({
        status: 'not-ready',
        reason: expect.stringContaining('peer-1'),
    });
    expect(channel.send).not.toHaveBeenCalled();
});
```

Expose the private send path through the existing test harness rather than making production methods public.

- [ ] **Step 3: Run AL and multicast tests to verify failures**

Run: `npx vitest run packages/tests/shared/al-outbound-message-runtime.test.ts packages/tests/shared/multicast-policy-integration.test.ts`

Expected: FAIL because `sendPreparedMessage` only returns `Promise<void>` and multicast still throws through `QRtcDataChannel.sendRawOrThrow`.

- [ ] **Step 4: Add typed prepared send result contract**

In `packages/shared/alm/ALOutboundMessageRuntime.ts`, add:

```ts
export type ALOutboundPreparedSendStatus =
    | 'sent'
    | 'no-targets'
    | 'not-ready';

export type ALOutboundPreparedSendResult = Readonly<{
    status: ALOutboundPreparedSendStatus;
    reason?: string;
    retryAfterMs?: number;
}>;
```

Change the input contract:

```ts
sendPreparedMessage: (
    prepared: TPrepared,
    phase: ALOutboundDispatchPhase,
) => Promise<void | ALOutboundPreparedSendResult>;
```

In `runDurableEffectDrainLoop()`, let `runDurableEffect(...)` return a reschedule instruction:

```ts
type ALDurableEffectRunResult =
    | Readonly<{ status: 'completed' }>
    | Readonly<{ status: 'reschedule'; readyAtMs: number; reason: string }>;
```

For `send-prepared`, normalize `undefined` to `{ status: 'sent' }`. Return `completed` for `sent` and `no-targets`. Return `reschedule` for `not-ready`:

```ts
case 'send-prepared': {
    const result = await this.input.sendPreparedMessage(
        effect.payload.prepared,
        effect.payload.phase,
    ) ?? { status: 'sent' as const };
    if (result.status === 'not-ready') {
        return {
            status: 'reschedule',
            readyAtMs: this.readNowMs() + (result.retryAfterMs ?? this.toEffectRetryDelayMs(effect.attempts)),
            reason: result.reason ?? 'Prepared outbound transport is not ready.',
        };
    }
    return { status: 'completed' };
}
```

Update the drain loop so a `reschedule` result calls `admissionStore.rescheduleEffect(...)` and does not call `completeEffect(...)`.

- [ ] **Step 5: Preflight RTC multicast send state**

In `packages/shared/multicast/WebRtcOverlayMulticastManager.ts`, import `ALOutboundPreparedSendResult` and change private `sendPreparedMessage(...)` to return that type.

Use `peer.channel.readHealth()` before `peer.channel.send(msg)`:

```ts
if (!peerId) {
    return {
        status: 'no-targets',
        reason: 'Skipping RTC send without immediate next hop',
    };
}

const peer = this.connectionService.readPeer(peerId);
const health = peer?.channel?.readHealth();
if (!peer?.channel || health?.readyState !== 'open') {
    return {
        status: 'not-ready',
        reason: `RTC channel for peer ${peerId} is not open`,
        retryAfterMs: 100,
    };
}

await peer.channel.send(msg);
return { status: 'sent' };
```

Update `sendImmediately(...)` to ignore `no-targets`, retry/queue `not-ready` through the existing durable outbox path, and keep `sent` as success.

- [ ] **Step 6: Keep WS services source-compatible**

Update `packages/shared/services/WsQueueBoxClientService.ts` and `packages/shared/services/WsQueueBoxServerService.ts` send adapters:

```ts
sendPreparedMessage: async (msg, _phase) => {
    await this.sendPreparedMessage(msg);
    return { status: 'sent' as const };
},
```

- [ ] **Step 7: Run AL and multicast tests**

Run: `npx vitest run packages/tests/shared/al-outbound-message-runtime.test.ts packages/tests/shared/multicast-policy-integration.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit Task 4**

Run:

```bash
git add packages/shared/alm/ALOutboundMessageRuntime.ts packages/shared/multicast/WebRtcOverlayMulticastManager.ts packages/shared/services/WsQueueBoxClientService.ts packages/shared/services/WsQueueBoxServerService.ts packages/tests/shared/al-outbound-message-runtime.test.ts packages/tests/shared/multicast-policy-integration.test.ts
git commit -m "fix: treat rtc warmup as typed outbound readiness"
```

Expected: commit succeeds.

### Task 5: Make Director Relay Fall Back Reliably And Report Partial RTC Delivery

**Files:**
- Modify: `packages/shared-web/browser/rallar.ts`
- Test: `packages/tests/shared-web/rallar-director-relay-compat.test.ts`

- [ ] **Step 1: Add failing director relay fallback tests**

Extend `packages/tests/shared-web/rallar-director-relay-compat.test.ts`:

```ts
it('falls back to WS when director room RTC output has no open remote targets', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const facade = createRallarFacade();

    await facade.connect();
    appointLocalDirector(facade, 'arena-1');
    mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue([]);
    mocks.messagesRtcSend.mockResolvedValue({
        transport: 'rtc',
        status: 'no-targets',
        reason: 'solo room',
    });
    mocks.messagesWsSend.mockResolvedValue({
        transport: 'ws',
        status: 'sent',
    });

    const relay = facade.director.createRelay(createRelayConfig('arena-1'));
    await expect(relay.sendOutput({ type: 'snapshot' })).resolves.toMatchObject({
        status: 'sent',
        rtc: { status: 'no-targets' },
        ws: { status: 'sent' },
    });
});

it('reports partial when RTC reaches some peers and WS fallback succeeds', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const facade = createRallarFacade();

    await facade.connect();
    appointLocalDirector(facade, 'arena-1');
    mocks.messagesRtcSend.mockResolvedValue({
        transport: 'rtc',
        status: 'partial',
        reason: 'one peer not open',
    });
    mocks.messagesWsSend.mockResolvedValue({
        transport: 'ws',
        status: 'sent',
    });

    const relay = facade.director.createRelay(createRelayConfig('arena-1'));
    await expect(relay.sendSnapshot({ tick: 1 })).resolves.toMatchObject({
        status: 'partial',
        rtc: { status: 'partial' },
        ws: { status: 'sent' },
    });
});
```

Use the existing relay test helper names in the file; the expected status behavior must remain as shown.

- [ ] **Step 2: Run relay tests and verify current behavior**

Run: `npx vitest run packages/tests/shared-web/rallar-director-relay-compat.test.ts`

Expected: FAIL where `sendDirectorRoomEnvelope(...)` flattens fallback success to `sent` or treats RTC no-targets as failure without preserving the diagnostic status.

- [ ] **Step 3: Extend relay send statuses**

Modify `RallarDirectorRelaySendStatus` in `packages/shared-web/browser/rallar.ts`:

```ts
export type RallarDirectorRelaySendStatus =
    | 'sent'
    | 'partial'
    | 'no-targets'
    | 'not-ready'
    | 'no-director'
    | 'not-director'
    | 'stale-director'
    | 'failed';
```

Update the relay result mapper so:

- RTC `sent` and WS not needed returns `sent`.
- RTC `partial` with WS success returns `partial`.
- RTC `no-targets` with WS success returns `sent` for reliable room output and preserves `rtc.status`.
- RTC `not-ready` with WS success returns `sent` for reliable room output and `not-ready` for best-effort-only callers.
- Both RTC and WS failed returns `failed`.

- [ ] **Step 4: Update `sendDirectorRoomEnvelope(...)`**

In `packages/shared-web/browser/rallar.ts`, change the fallback return block:

```ts
const wsSucceeded = isSuccessfulRallarMessageSendStatus(ws.status);
if (!wsSucceeded) {
    return {
        status: 'failed',
        rtc,
        ws,
        reason: ws.reason ?? rtc.reason,
    };
}

return {
    status: rtc.status === 'partial' ? 'partial' : 'sent',
    rtc,
    ws,
    reason: rtc.status === 'partial' ? rtc.reason : undefined,
};
```

Keep `sendDirectorIntent(...)` fallback-to-WS behavior and add a regression assertion that targeted RTC not-ready still sends WS unicast.

- [ ] **Step 5: Run relay tests**

Run: `npx vitest run packages/tests/shared-web/rallar-director-relay-compat.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit Task 5**

Run:

```bash
git add packages/shared-web/browser/rallar.ts packages/tests/shared-web/rallar-director-relay-compat.test.ts
git commit -m "fix: preserve director relay rtc fallback readiness"
```

Expected: commit succeeds.

### Task 6: Expose Rallar Game Authority And Egress Readiness Separately

**Files:**
- Modify: `packages/shared-web/game/types.ts`
- Modify: `packages/shared-web/game/match.ts`
- Modify: `packages/shared-web/game/diagnostics.ts`
- Test: `packages/tests/shared-web/rallar-game-match.test.ts`

- [ ] **Step 1: Add failing game status tests**

Extend `packages/tests/shared-web/rallar-game-match.test.ts`:

```ts
it('marks a solo auto-appointed director as active with empty realtime egress', async () => {
    const rallar = createFakeRallar({
        localSessionId: 'director',
        roomActiveSessionIds: ['director'],
        rtcRoomLaneResult: {
            status: 'empty',
            readyPeerIds: [],
            notReadyPeerIds: [],
        },
    });
    const match = createTestMatch({ rallar });

    await match.start();
    await match.appointIfElected({ reason: 'auto' });
    await match.waitForReadyLanes({ expect: { exact: 0 }, timeoutMs: 10 });

    expect(match.status()).toMatchObject({
        directorPeerId: 'director',
        directorIsFresh: true,
        directorAuthority: 'active',
        egress: {
            reliable: 'ready',
            realtime: 'empty',
        },
    });
});

it('keeps local director authority active while remote realtime lanes warm', async () => {
    const rallar = createFakeRallar({
        localSessionId: 'director',
        roomActiveSessionIds: ['director', 'peer-1'],
        rtcRoomLaneResult: {
            status: 'timeout',
            readyPeerIds: [],
            notReadyPeerIds: ['peer-1'],
        },
    });
    const match = createTestMatch({ rallar });

    await match.start();
    await match.appointIfElected({ reason: 'auto' });
    await match.waitForReadyLanes({ expect: { exact: 1 }, timeoutMs: 1 });

    expect(match.status()).toMatchObject({
        directorAuthority: 'active',
        egress: {
            reliable: 'ready',
            realtime: 'warming',
        },
    });
});
```

- [ ] **Step 2: Run game match tests and verify missing status fields**

Run: `npx vitest run packages/tests/shared-web/rallar-game-match.test.ts`

Expected: FAIL because `RallarGameMatchStatus` lacks `directorAuthority` and `egress`.

- [ ] **Step 3: Extend game status types**

Modify `packages/shared-web/game/types.ts`:

```ts
export type RallarGameDirectorAuthority =
    | 'none'
    | 'candidate'
    | 'active'
    | 'stale';

export type RallarGameReliableEgressState =
    | 'empty'
    | 'ready'
    | 'partial'
    | 'timeout'
    | 'failed';

export type RallarGameRealtimeEgressState =
    | 'empty'
    | 'warming'
    | 'ready'
    | 'partial'
    | 'timeout'
    | 'failed';
```

Extend `RallarGameLaneReadyOptions`:

```ts
expect?: RallarReadinessExpectation;
```

Extend `RallarGameMatchStatus`:

```ts
directorAuthority: RallarGameDirectorAuthority;
egress: Readonly<{
    reliable: RallarGameReliableEgressState;
    realtime: RallarGameRealtimeEgressState;
}>;
```

Extend `RallarGamePeerReadiness` with `expectedCount`, `observedCount`, `missingPeerIds`, and `extraPeerIds`.

- [ ] **Step 4: Populate authority and egress state in match runtime**

In `packages/shared-web/game/match.ts`, add local state:

```ts
let reliableEgress: RallarGameReliableEgressState = 'empty';
let realtimeEgress: RallarGameRealtimeEgressState = 'empty';
```

In `waitForReadyLanes(...)`, pass `options.expect` to `rallar.rtc.waitForRoomLane(...)`, and map statuses:

```ts
realtimeEgress = toRealtimeEgressState(lastPeerReadiness.status);
refreshStatus();
```

Add mapping helpers:

```ts
function toDirectorAuthority(status: RallarDirectorStatus): RallarGameDirectorAuthority {
    if (!status.appointment) {
        return 'none';
    }
    if (!status.isFresh) {
        return 'stale';
    }
    return status.isDirector ? 'active' : 'candidate';
}

function toRealtimeEgressState(
    status: RallarGamePeerReadiness['status'],
): RallarGameRealtimeEgressState {
    switch (status) {
        case 'open':
            return 'ready';
        case 'empty':
            return 'empty';
        case 'partial':
            return 'partial';
        case 'timeout':
        case 'not-ready':
        case 'not-connected':
            return 'warming';
        case 'failed':
        case 'aborted':
        case 'no-room':
            return 'failed';
    }
}
```

In `createStatus(...)`, set:

```ts
directorAuthority: toDirectorAuthority(directorStatus),
egress: {
    reliable: reliableEgress,
    realtime: realtimeEgress,
},
```

Set `reliableEgress` to `ready` after `rooms.waitForPresence(... { expect: { min: 1 } })` resolves ready for the local room. Leave it `empty` only when there is no room or no active session.

- [ ] **Step 5: Update diagnostics derivation**

Modify `packages/shared-web/game/diagnostics.ts` so diagnostics includes the new fields and does not mark `lane-empty` as an issue:

```ts
directorAuthority: input.status.directorAuthority,
egress: input.status.egress,
```

Add issues only for degraded egress:

```ts
if (input.status.egress.realtime === 'warming') {
    issues.push('rtc-warming');
}
if (input.status.egress.realtime === 'failed') {
    issues.push('rtc-failed');
}
```

- [ ] **Step 6: Run game match tests**

Run: `npx vitest run packages/tests/shared-web/rallar-game-match.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit Task 6**

Run:

```bash
git add packages/shared-web/game/types.ts packages/shared-web/game/match.ts packages/shared-web/game/diagnostics.ts packages/tests/shared-web/rallar-game-match.test.ts
git commit -m "feat: expose game authority and egress readiness"
```

Expected: commit succeeds.

### Task 7: Update AR Eye Hunter Solo Director Flow And Diagnostics

**Files:**
- Modify: `apps/ar-eye-hunter-v1/src/game/useRallarArena.ts`
- Modify: `apps/ar-eye-hunter-v1/src/App.tsx`
- Test: `packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts`

- [ ] **Step 1: Add failing AR Eye lifecycle tests**

Extend `packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts`:

```ts
it('starts solo play after room creation without waiting for remote RTC peers', async () => {
    const harness = renderRallarArenaHook({
        autoCreateRoom: true,
        localSessionId: 'director',
        roomActiveSessionIds: ['director'],
        rtcRoomLaneResult: {
            status: 'empty',
            readyPeerIds: [],
            notReadyPeerIds: [],
        },
    });

    await harness.waitForDirectorAttempt('appointed');

    expect(harness.current.directorStatus.isDirector).toBe(true);
    expect(harness.current.gameDiagnostics).toMatchObject({
        directorAuthority: 'active',
        egress: {
            reliable: 'ready',
            realtime: 'empty',
        },
    });
    expect(harness.current.error).toBeUndefined();
});

it('syncs a late peer after presence and rtc lane readiness change', async () => {
    const harness = renderRallarArenaHook({
        autoCreateRoom: true,
        localSessionId: 'director',
        roomActiveSessionIds: ['director'],
        rtcRoomLaneResult: {
            status: 'empty',
            readyPeerIds: [],
            notReadyPeerIds: [],
        },
    });

    await harness.waitForDirectorAttempt('appointed');
    harness.updateRoomPresence(['director', 'peer-1']);
    harness.updateRtcRoomLaneResult({
        status: 'open',
        readyPeerIds: ['peer-1'],
        notReadyPeerIds: [],
    });

    await harness.waitForPublishedSnapshot();

    expect(harness.publishedSnapshots.at(-1)).toMatchObject({
        reliable: true,
    });
    expect(harness.current.gameDiagnostics).toMatchObject({
        egress: {
            realtime: 'ready',
        },
    });
});
```

Use existing hook render helpers in the file; keep assertions on observable hook state and publish calls.

- [ ] **Step 2: Run AR Eye lifecycle tests and verify current blocking behavior**

Run: `npx vitest run packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts`

Expected: FAIL because startup treats lane waiting and sync as one blocking sequence and diagnostics lack separated egress state.

- [ ] **Step 3: Split local authority startup from remote egress warm-up**

In `apps/ar-eye-hunter-v1/src/game/useRallarArena.ts`, replace the sequential startup block:

```ts
await attemptDirectorAppointment('auto');
await match.waitForReadyLanes({ laneIds: [...], timeoutMs: 650 });
setGameDiagnostics(match.diagnostics());
await match.requestSync({ reason: 'arena-join' });
```

with:

```ts
await attemptDirectorAppointment('auto');
setGameDiagnostics(match.diagnostics());

void runBestEffortNetworkTask(async () => {
    const readiness = await match.waitForReadyLanes({
        laneIds: [
            GAME_MOTION_LANE_ID,
            GAME_COMBAT_LANE_ID,
            GAME_SNAPSHOT_LANE_ID,
            GAME_FX_LANE_ID,
            GAME_AI_LANE_ID,
        ],
        expect: { min: 0 },
        timeoutMs: 650,
    });
    setGameDiagnostics(match.diagnostics());
    if (readiness.status === 'open' || readiness.status === 'partial') {
        await match.requestSync({ reason: 'arena-peer-ready' });
    }
}, generation);

await match.requestSync({ reason: 'arena-join' });
```

The local director path in `match.requestSync(...)` already routes locally and publishes a reliable snapshot when one exists, so solo play remains active.

- [ ] **Step 4: Trigger sync when peer readiness changes after startup**

Add a small effect near the existing network lifecycle effects:

```ts
useEffect(() => {
    if (!isNetworkEnabled || !roomId || !arenaMatchRef.current || !currentSession) {
        return;
    }
    const match = arenaMatchRef.current;
    if (match.status().directorPeerId !== currentSession.sessionId) {
        return;
    }

    const generation = networkGenerationRef.current;
    void runBestEffortNetworkTask(async () => {
        const readiness = await match.waitForReadyLanes({
            laneIds: [GAME_SNAPSHOT_LANE_ID],
            expect: { min: 1 },
            timeoutMs: 1_000,
        });
        setGameDiagnostics(match.diagnostics());
        if (readiness.status === 'open' || readiness.status === 'partial') {
            await match.requestSync({ reason: 'arena-peer-ready' });
        }
    }, generation);
}, [currentSession, isNetworkEnabled, roomId, transportDiagnostics.rtc?.readyPeerIds.length]);
```

This keeps the game server/director loop local-first and sends reliable sync only after at least one remote snapshot lane opens.

- [ ] **Step 5: Show authority and egress diagnostics in the UI**

In `apps/ar-eye-hunter-v1/src/App.tsx`, update the diagnostics rows:

```tsx
<DiagnosticsRow
    label="Authority"
    value={arena.gameDiagnostics?.directorAuthority ?? 'unknown'}
/>
<DiagnosticsRow
    label="Reliable"
    value={arena.gameDiagnostics?.egress.reliable ?? 'unknown'}
/>
<DiagnosticsRow
    label="RTC"
    value={arena.gameDiagnostics?.egress.realtime ?? 'unknown'}
/>
```

Keep the existing director and ready-peer rows so current operators still see peer counts.

- [ ] **Step 6: Run AR Eye lifecycle tests**

Run: `npx vitest run packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit Task 7**

Run:

```bash
git add apps/ar-eye-hunter-v1/src/game/useRallarArena.ts apps/ar-eye-hunter-v1/src/App.tsx packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts
git commit -m "fix: keep ar eye solo director active during rtc warmup"
```

Expected: commit succeeds.

### Task 8: Validate The Integrated Change Set

**Files:**
- Validate: `packages/shared`
- Validate: `packages/shared-web`
- Validate: `apps/ar-eye-hunter-v1`

- [ ] **Step 1: Run focused shared-web tests**

Run:

```bash
npx vitest run packages/tests/shared-web/rallar-readiness.test.ts packages/tests/shared-web/rallar-rtc-wait-compat.test.ts packages/tests/shared-web/rallar-director-relay-compat.test.ts packages/tests/shared-web/rallar-game-match.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run focused shared runtime tests**

Run:

```bash
npx vitest run packages/tests/shared/al-outbound-message-runtime.test.ts packages/tests/shared/multicast-policy-integration.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run focused AR Eye tests**

Run:

```bash
npx vitest run packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts
```

Expected: PASS.

- [ ] **Step 4: Type-check changed packages**

Run:

```bash
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-web/tsconfig.json --noEmit
```

Expected: both commands exit 0.

- [ ] **Step 5: Build AR Eye Hunter**

Run:

```bash
npm --workspace ar-eye-hunter-v1 run build
```

Expected: exit 0. Vite may print large-chunk warnings; treat the exit code as authoritative for this plan.

- [ ] **Step 6: Run broader unit suite**

Run:

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 7: Run focused browser validation when UI rows change**

Run the app locally:

```bash
npm --workspace ar-eye-hunter-v1 run dev -- --host 127.0.0.1
```

Expected: dev server starts and prints a localhost URL.

Open the app at that URL and verify:

- Solo created arena shows `Director: you` or equivalent existing director label.
- `Authority` is `active`.
- `Reliable` is `ready`.
- `RTC` is `empty` before peers join.
- No console error contains `Data channel not open`.

- [ ] **Step 8: Final status check**

Run:

```bash
git status --short
git diff -- packages/shared packages/shared-web apps/ar-eye-hunter-v1 packages/tests
```

Expected: no unstaged task changes remain after the task commits. If the task commits were intentionally skipped, stage only reviewed task hunks from the exact files listed in Tasks 1-7 and commit with `feat: separate director readiness from rtc egress`.

## Completion Criteria

- `rallar.rooms.waitForPresence(...)` supports `min`, `max`, `exact`, and `sessionIds` expectations.
- `rallar.rtc.waitForRoomLane(...)` supports the same expectation shape for remote RTC peers.
- Solo room creator can be active director with no remote RTC peers.
- Late peers receive reliable sync after they are present and realtime traffic only after RTC lanes open.
- AL/multicast no longer logs raw `Data channel not open` errors during normal channel warm-up.
- AR Eye diagnostics distinguish authority, reliable egress, and realtime egress.
- Focused tests, package type-checks, AR Eye build, and `npm run test:unit` pass.
