import { normalizeWaitTimeoutMs } from '@shared-web/browser/connection/normalize-wait-timeout-ms.ts';
import type { RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import {
    evaluateRallarReadinessExpectation,
    normalizeRallarReadinessExpectation,
    type RallarNormalizedReadinessExpectation,
    type RallarReadinessStatus
} from '@shared-web/browser/readiness.ts';
import { isGroupActive } from '@shared/api/group-client-views.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import type { RallarRoomPresenceWaitOptions, RallarRoomPresenceWaitResult } from './rallar-room-contracts.ts';
import type { RallarRoomStateStorePort } from './room-state-store.ts';
import { waitForRoomChange } from './wait-for-room-change.ts';

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
    return await waitForRoomChange({
        readResult: () => readResult(),
        isSettled: isTerminalReadinessWaitResult,
        subscribe: input.onCacheChange,
        signal: operationOptions.signal,
        timeoutMs: normalizeWaitTimeoutMs(options.timeoutMs),
        toTimedOut: () => readResult('timeout'),
        toAborted: () => ({ ...readResult(), status: 'aborted' })
    });
}

function createRoomPresenceResultReader(
    input: CreateRoomPresenceResultReaderInput
): RoomPresenceResultReader {
    return (statusOverride?: RallarReadinessStatus): RallarRoomPresenceWaitResult => {
        const snapshot = input.stateStore.findGroupSnapshot(input.roomRef ?? input.room);
        if (!snapshot || !isGroupActive(snapshot)) {
            return {
                ...evaluateRallarReadinessExpectation([], input.expectation),
                status: statusOverride ?? 'not-found',
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
