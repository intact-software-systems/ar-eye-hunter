import { useCallback, useEffect } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarDirectorStatus } from '@shared-web/browser/rallar.ts';
import { rallar } from '@shared-web/browser/rallar.ts';
import { createRallarBrowserAi } from '@shared-web/browser/rallar-ai.ts';

import {
    type AvatarProfile,
    createAvatarProfileMockProvider,
    createAvatarProfileRequest,
    createDeterministicAvatarProfile,
    validateAvatarProfile,
} from '../../avatarProfile.ts';
import { createArenaBrowserAiProvider } from '../../browserAiProvider.ts';
import { resolveArenaBrowserAiConfig } from '../../browserAiConfig.ts';
import type { ArenaRallarGameMatchHandle } from '../../rallar-game-match-adapter.ts';
import type { ArenaSnapshot } from '../../types.ts';
import type { ArenaTransportDiagnostics } from '../arena-connection-contracts.ts';
import { toErrorMessage } from '../arena-connection-helpers.ts';

const BROWSER_RALLAR_AI_CONFIG = resolveArenaBrowserAiConfig();
const ARENA_RELIABLE_SNAPSHOT_MIN_INTERVAL_MS = 1_000;

interface ArenaNetworkTransportSupportInput {
    readonly arenaMatchRef: RefObject<ArenaRallarGameMatchHandle | undefined>;
    readonly arenaSnapshotRef: RefObject<ArenaSnapshot | undefined>;
    readonly clearPendingReliableArenaSnapshot: () => void;
    readonly directorStatusRef: RefObject<RallarDirectorStatus>;
    readonly isCurrentNetworkGeneration: (generation: number) => boolean;
    readonly localAvatarProfileRef: RefObject<AvatarProfile | undefined>;
    readonly networkGenerationRef: RefObject<number>;
    readonly reliableSnapshotLastSentAtRef: RefObject<number | undefined>;
    readonly reliableSnapshotLastSentRevisionRef: RefObject<number | undefined>;
    readonly reliableSnapshotPendingRef: RefObject<ArenaSnapshot | undefined>;
    readonly reliableSnapshotTimerRef: RefObject<number | undefined>;
    readonly roomId: string | undefined;
    readonly roomIdRef: RefObject<string | undefined>;
    readonly session: AuthSession | undefined;
    readonly setTransportDiagnostics: Dispatch<SetStateAction<ArenaTransportDiagnostics>>;
}

export interface ArenaNetworkTransportSupport {
    readonly runBestEffortNetworkTask: <T>(
        task: () => Promise<T> | undefined,
        generation?: number,
    ) => void;
    readonly scheduleReliableArenaSnapshot: (
        snapshot: ArenaSnapshot,
        generation: number,
    ) => void;
}

export function useArenaNetworkTransportSupport(
    input: ArenaNetworkTransportSupportInput,
): ArenaNetworkTransportSupport {
    const {
        arenaMatchRef,
        arenaSnapshotRef,
        clearPendingReliableArenaSnapshot,
        directorStatusRef,
        isCurrentNetworkGeneration,
        localAvatarProfileRef,
        networkGenerationRef,
        reliableSnapshotLastSentAtRef,
        reliableSnapshotLastSentRevisionRef,
        reliableSnapshotPendingRef,
        reliableSnapshotTimerRef,
        roomId,
        roomIdRef,
        session,
        setTransportDiagnostics,
    } = input;

    const recordNetworkSendFailure = useCallback((
        generation: number,
        error: Error,
    ) => {
        if (!isCurrentNetworkGeneration(generation)) {
            return;
        }
        setTransportDiagnostics((previous) => ({
            ...previous,
            error: toErrorMessage(error),
        }));
    }, [isCurrentNetworkGeneration]);

    const runBestEffortNetworkTask = useCallback(<T>(
        task: () => Promise<T> | undefined,
        generation = networkGenerationRef.current,
    ) => {
        if (!isCurrentNetworkGeneration(generation)) {
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
                    error instanceof Error ? error : new Error(String(error)),
                )
            );
        } catch (error) {
            recordNetworkSendFailure(
                generation,
                error instanceof Error ? error : new Error(String(error)),
            );
        }
    }, [isCurrentNetworkGeneration, recordNetworkSendFailure]);

    const sendReliableArenaSnapshot = useCallback((
        snapshot: ArenaSnapshot,
        generation: number,
    ) => {
        if (!isCurrentNetworkGeneration(generation)) {
            return;
        }
        const currentRoomId = roomIdRef.current;
        const currentDirector = directorStatusRef.current;
        const match = arenaMatchRef.current;
        if (!currentRoomId || !currentDirector.isDirector || !currentDirector.isFresh || !match) {
            return;
        }
        const lastSentRevision = reliableSnapshotLastSentRevisionRef.current;
        if (lastSentRevision !== undefined && snapshot.revision <= lastSentRevision) {
            return;
        }
        reliableSnapshotLastSentRevisionRef.current = snapshot.revision;
        reliableSnapshotLastSentAtRef.current = Date.now();
        runBestEffortNetworkTask(() =>
            match.publishSnapshot(snapshot, {
                reliable: true,
            }), generation);
    }, [isCurrentNetworkGeneration, runBestEffortNetworkTask]);

    const scheduleReliableArenaSnapshot = useCallback((
        snapshot: ArenaSnapshot,
        generation: number,
    ) => {
        const lastSentRevision = reliableSnapshotLastSentRevisionRef.current;
        if (lastSentRevision !== undefined && snapshot.revision <= lastSentRevision) {
            return;
        }
        const pendingSnapshot = reliableSnapshotPendingRef.current;
        if (pendingSnapshot && snapshot.revision <= pendingSnapshot.revision) {
            return;
        }

        const now = Date.now();
        const lastSentAt = reliableSnapshotLastSentAtRef.current;
        if (
            lastSentAt === undefined ||
            now - lastSentAt >= ARENA_RELIABLE_SNAPSHOT_MIN_INTERVAL_MS
        ) {
            clearPendingReliableArenaSnapshot();
            sendReliableArenaSnapshot(snapshot, generation);
            return;
        }

        reliableSnapshotPendingRef.current = snapshot;
        if (reliableSnapshotTimerRef.current !== undefined) {
            return;
        }

        reliableSnapshotTimerRef.current = window.setTimeout(() => {
            reliableSnapshotTimerRef.current = undefined;
            const pending = reliableSnapshotPendingRef.current;
            reliableSnapshotPendingRef.current = undefined;
            if (pending) {
                sendReliableArenaSnapshot(pending, generation);
            }
        }, Math.max(0, ARENA_RELIABLE_SNAPSHOT_MIN_INTERVAL_MS - (now - lastSentAt)));
    }, [
        clearPendingReliableArenaSnapshot,
        sendReliableArenaSnapshot,
    ]);

    return { runBestEffortNetworkTask, scheduleReliableArenaSnapshot };
}
