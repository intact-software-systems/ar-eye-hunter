import { normalizeWaitTimeoutMs } from '@shared-web/browser/connection/normalize-wait-timeout-ms.ts';
import { waitForSettledRead } from '@shared-web/browser/connection/wait-for-settled-read.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import {
    evaluateRallarReadinessExpectation,
    normalizeRallarReadinessExpectation,
    type RallarNormalizedReadinessExpectation,
    type RallarReadinessStatus
} from '@shared-web/browser/readiness.ts';
import { toStateScope } from '@shared/api/api-type-utils.ts';
import { isGroupActive } from '@shared/api/group-client-views.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { Command } from '@shared/cache/Command.ts';
import { TryWithPolicy } from '@shared/resilience/try-with-policy.ts';

import { readStateGroupSnapshot } from '../state-read/point-read.ts';
import type { RallarRoomPresenceWaitOptions, RallarRoomPresenceWaitResult } from './rallar-room-contracts.ts';
import type { GroupSnapshot } from './room-group-state-translation.ts';
import type { RoomSessionFence } from './room-session-fence.ts';
import type { RallarRoomStateStorePort } from './room-state-store.ts';

export interface WaitForRoomPresenceInput {
    readonly room: string | GroupRef;
    readonly options?: RallarRoomPresenceWaitOptions;
    readonly stateStore: RallarRoomStateStorePort;
    readonly resolveOperationOptions: <T extends RallarOperationOptions>(
        options: T
    ) => T & RallarOperationOptions;
    readonly resolveRoomRef: (
        room: string | GroupRef,
        scope?: RallarRoomPresenceWaitOptions['scope']
    ) => GroupRef | undefined;
    readonly onCacheChange: (listener: () => void | Promise<void>) => RallarUnsubscribe;
}

export interface SummarisedRoomPresenceInput {
    /** The presence write's reply; every later read is floored at its revision. */
    readonly snapshot: GroupSnapshot;
    readonly fence: RoomSessionFence;
    readonly context: ApiMiddleware;
    readonly options: RallarOperationOptions;
    isSummarised(snapshot: GroupSnapshot): boolean;
}

interface CreateRoomPresenceResultReaderInput {
    readonly stateStore: RallarRoomStateStorePort;
    readonly room: string | GroupRef;
    readonly roomId: string;
    readonly roomRef: GroupRef | undefined;
    readonly expectation: RallarNormalizedReadinessExpectation;
}

type RoomPresenceResultReader = (
    statusOverride?: RallarReadinessStatus
) => RallarRoomPresenceWaitResult;

export async function waitForRoomPresence(
    input: WaitForRoomPresenceInput
): Promise<RallarRoomPresenceWaitResult> {
    const options = input.options ?? {};
    const operationOptions = input.resolveOperationOptions(options);
    const roomId = typeof input.room === 'string' ? input.room : input.room.groupId;
    const roomRef = input.resolveRoomRef(input.room, options.scope);
    const expectation = normalizeRallarReadinessExpectation(options.expect);
    const readResult = createRoomPresenceResultReader({
        stateStore: input.stateStore,
        room: input.room,
        roomId,
        roomRef,
        expectation
    });
    return await waitForSettledRead({
        readResult: () => readResult(),
        isSettled: isTerminalReadinessWaitResult,
        subscribe: input.onCacheChange,
        signal: operationOptions.signal,
        timeoutMs: normalizeWaitTimeoutMs(options.timeoutMs),
        toTimedOut: () => readResult('timeout'),
        toAborted: () => ({ ...readResult(), status: 'aborted' })
    });
}

/** Presence writes commit before their summary. A successful response alone does not prove arrival. */
export async function readSummarisedRoomPresence(input: SummarisedRoomPresenceInput): Promise<GroupSnapshot> {
    if (input.isSummarised(input.snapshot)) {
        return input.snapshot;
    }
    const timeoutMs = input.options.timeoutMs ?? 15000;
    return await new Command(async (signal) => {
        return await TryWithPolicy.defaults().label('room presence')
            .maxElapsedMsecs(timeoutMs)
            .retryIntervalMsecs(100).maxRetryIntervalMsecs(500)
            .retryIf((error) => error instanceof RoomPresencePendingError && !signal?.aborted)
            .run(() => readSummarisedSnapshot(input, signal));
    }, { signal: input.options.signal, timeoutMs }).run();
}

async function readSummarisedSnapshot(
    input: SummarisedRoomPresenceInput,
    signal: AbortSignal | undefined
): Promise<GroupSnapshot> {
    signal?.throwIfAborted();
    input.fence.assertCurrent(input.context);
    const { group, causalRevision } = input.snapshot;
    const { snapshot } = await readStateGroupSnapshot(group.groupId, toStateScope(group), {
        authSession: input.fence.session,
        signal,
        minCausalRevision: causalRevision
    });
    input.fence.assertCurrent(input.context);
    if (!input.isSummarised(snapshot)) {
        throw new RoomPresencePendingError('Room presence has not confirmed the switch yet. Retry entering.');
    }
    return snapshot;
}

function createRoomPresenceResultReader(
    input: CreateRoomPresenceResultReaderInput
): RoomPresenceResultReader {
    return (statusOverride?: RallarReadinessStatus): RallarRoomPresenceWaitResult => {
        const snapshot = input.stateStore.findGroupSnapshot(input.roomRef ?? input.room);
        if (!snapshot || !isGroupActive(snapshot)) {
            // An inactive room is gone for presence; an expired snapshot is not,
            // so only a room this browser never held settles as not-found.
            const absent = snapshot !== undefined ||
                !input.stateStore.wasGroupSnapshotObserved(input.roomRef ?? input.room);
            return {
                ...evaluateRallarReadinessExpectation([], input.expectation),
                status: statusOverride ?? (absent ? 'not-found' : 'timeout'),
                roomId: input.roomId,
                roomRef: input.roomRef,
                activeSessionIds: [],
                timedOut: statusOverride === 'timeout'
            };
        }
        const activeSessionIds = uniquePeerIds(
            snapshot.activeSessions.map((session) => session.sessionId)
        );
        const evaluation = evaluateRallarReadinessExpectation(activeSessionIds, input.expectation);
        return {
            ...evaluation,
            status: statusOverride ?? evaluation.status,
            roomId: input.roomId,
            roomRef: snapshot.group,
            activeSessionIds,
            timedOut: statusOverride === 'timeout'
        };
    };
}

function uniquePeerIds(peerIds: readonly string[]): readonly string[] {
    return [...new Set(peerIds)];
}

function isTerminalReadinessWaitResult(result: RallarRoomPresenceWaitResult): boolean {
    return result.status === 'ready' || result.status === 'not-found';
}

class RoomPresencePendingError extends Error {}
