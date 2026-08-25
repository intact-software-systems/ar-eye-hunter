import type { RallarDirectorStatus } from '@shared-web/browser/rallar.ts';
import { useCallback } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

import type { ArenaRallarGameMatchHandle } from '../../rallar-game-match-adapter.ts';
import type { ArenaSnapshot } from '../../types.ts';
import type { ArenaTransportDiagnostics } from '../arena-connection-contracts.ts';
import { toErrorMessage } from '../arena-connection-helpers.ts';

const ARENA_RELIABLE_SNAPSHOT_MIN_INTERVAL_MS = 1_000;

interface ArenaNetworkTransportSupportInput {
    readonly arenaMatchRef: RefObject<ArenaRallarGameMatchHandle | undefined>;
    readonly clearPendingReliableArenaSnapshot: () => void;
    readonly directorStatusRef: RefObject<RallarDirectorStatus>;
    readonly isCurrentNetworkGeneration: (generation: number) => boolean;
    readonly networkGenerationRef: RefObject<number>;
    readonly reliableSnapshotLastSentAtRef: RefObject<number | undefined>;
    readonly reliableSnapshotLastSentRevisionRef: RefObject<number | undefined>;
    readonly reliableSnapshotPendingRef: RefObject<ArenaSnapshot | undefined>;
    readonly reliableSnapshotTimerRef: RefObject<number | undefined>;
    readonly roomIdRef: RefObject<string | undefined>;
    readonly setTransportDiagnostics: Dispatch<SetStateAction<ArenaTransportDiagnostics>>;
}

export interface ArenaNetworkTransportSupport {
    readonly runBestEffortNetworkTask: <T>(
        task: () => Promise<T> | undefined,
        generation?: number
    ) => void;
    readonly scheduleReliableArenaSnapshot: (
        snapshot: ArenaSnapshot,
        generation: number
    ) => void;
}

export function useArenaNetworkTransportSupport(
    input: ArenaNetworkTransportSupportInput
): ArenaNetworkTransportSupport {
    const recordNetworkSendFailure = useRecordNetworkSendFailure(input);
    const runBestEffortNetworkTask = useRunBestEffortNetworkTask(
        input,
        recordNetworkSendFailure
    );
    const sendReliableArenaSnapshot = useSendReliableArenaSnapshot(
        input,
        runBestEffortNetworkTask
    );
    const scheduleReliableArenaSnapshot = useScheduleReliableArenaSnapshot(
        input,
        sendReliableArenaSnapshot
    );

    return { runBestEffortNetworkTask, scheduleReliableArenaSnapshot };
}

function useRecordNetworkSendFailure(
    input: ArenaNetworkTransportSupportInput
): (generation: number, error: Error) => void {
    return useCallback(
        (generation: number, error: Error) => {
            if (!input.isCurrentNetworkGeneration(generation)) {
                return;
            }
            input.setTransportDiagnostics((previous) => ({
                ...previous,
                error: toErrorMessage(error)
            }));
        },
        [input.isCurrentNetworkGeneration]
    );
}

function useRunBestEffortNetworkTask(
    input: ArenaNetworkTransportSupportInput,
    recordNetworkSendFailure: (generation: number, error: Error) => void
): ArenaNetworkTransportSupport['runBestEffortNetworkTask'] {
    return useCallback(
        <T>(
            task: () => Promise<T> | undefined,
            generation = input.networkGenerationRef.current
        ) => {
            if (!input.isCurrentNetworkGeneration(generation)) {
                return;
            }
            try {
                const promise = task();
                if (!promise) {
                    return;
                }
                void promise.catch((error) =>
                    recordNetworkSendFailure(
                        generation,
                        error instanceof Error ? error : new Error(String(error))
                    )
                );
            }
            catch (error) {
                recordNetworkSendFailure(
                    generation,
                    error instanceof Error ? error : new Error(String(error))
                );
            }
        },
        [input.isCurrentNetworkGeneration, recordNetworkSendFailure]
    );
}

function useSendReliableArenaSnapshot(
    input: ArenaNetworkTransportSupportInput,
    runBestEffortNetworkTask: ArenaNetworkTransportSupport['runBestEffortNetworkTask']
): (snapshot: ArenaSnapshot, generation: number) => void {
    return useCallback(
        (snapshot: ArenaSnapshot, generation: number) => {
            if (!input.isCurrentNetworkGeneration(generation)) {
                return;
            }
            const currentRoomId = input.roomIdRef.current;
            const currentDirector = input.directorStatusRef.current;
            const match = input.arenaMatchRef.current;
            if (
                !currentRoomId ||
                !currentDirector.isDirector ||
                !currentDirector.isFresh ||
                !match
            ) {
                return;
            }
            const lastSentRevision = input.reliableSnapshotLastSentRevisionRef.current;
            if (
                lastSentRevision !== undefined &&
                snapshot.revision <= lastSentRevision
            ) {
                return;
            }
            input.reliableSnapshotLastSentRevisionRef.current = snapshot.revision;
            input.reliableSnapshotLastSentAtRef.current = Date.now();
            runBestEffortNetworkTask(
                () =>
                    match.publishSnapshot(snapshot, {
                        reliable: true
                    }),
                generation
            );
        },
        [input.isCurrentNetworkGeneration, runBestEffortNetworkTask]
    );
}

function useScheduleReliableArenaSnapshot(
    input: ArenaNetworkTransportSupportInput,
    sendReliableArenaSnapshot: (
        snapshot: ArenaSnapshot,
        generation: number
    ) => void
): ArenaNetworkTransportSupport['scheduleReliableArenaSnapshot'] {
    return useCallback(
        (snapshot: ArenaSnapshot, generation: number) => {
            const lastSentRevision = input.reliableSnapshotLastSentRevisionRef.current;
            if (
                lastSentRevision !== undefined &&
                snapshot.revision <= lastSentRevision
            ) {
                return;
            }
            const pendingSnapshot = input.reliableSnapshotPendingRef.current;
            if (pendingSnapshot && snapshot.revision <= pendingSnapshot.revision) {
                return;
            }

            const now = Date.now();
            const lastSentAt = input.reliableSnapshotLastSentAtRef.current;
            if (
                lastSentAt === undefined ||
                now - lastSentAt >= ARENA_RELIABLE_SNAPSHOT_MIN_INTERVAL_MS
            ) {
                input.clearPendingReliableArenaSnapshot();
                sendReliableArenaSnapshot(snapshot, generation);
                return;
            }

            input.reliableSnapshotPendingRef.current = snapshot;
            if (input.reliableSnapshotTimerRef.current !== undefined) {
                return;
            }

            input.reliableSnapshotTimerRef.current = window.setTimeout(
                () => {
                    input.reliableSnapshotTimerRef.current = undefined;
                    const pending = input.reliableSnapshotPendingRef.current;
                    input.reliableSnapshotPendingRef.current = undefined;
                    if (pending) {
                        sendReliableArenaSnapshot(pending, generation);
                    }
                },
                Math.max(
                    0,
                    ARENA_RELIABLE_SNAPSHOT_MIN_INTERVAL_MS - (now - lastSentAt)
                )
            );
        },
        [input.clearPendingReliableArenaSnapshot, sendReliableArenaSnapshot]
    );
}
