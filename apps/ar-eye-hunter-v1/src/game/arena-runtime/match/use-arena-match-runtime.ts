import { useEffect } from 'react';
import { rallar } from '@shared-web/browser/rallar.ts';

import { toErrorMessage } from '../arena-connection-helpers.ts';
import { createArenaMatchRuntime } from './create-arena-match-runtime.ts';
import { GAME_SNAPSHOT_LANE_ID } from '../../rallar-game-match-adapter.ts';
import {
    GAME_AI_LANE_ID,
    GAME_COMBAT_LANE_ID,
    GAME_FX_LANE_ID,
    GAME_MOTION_LANE_ID,
} from '../../types.ts';
import type {
    ArenaConnectionLifecycle,
    ArenaConnectionLifecycleInput,
} from '../lifecycle/use-arena-connection-lifecycle.ts';

export function useArenaMatchRuntime(
    input: ArenaConnectionLifecycleInput,
    attemptDirectorAppointment: ArenaConnectionLifecycle['attemptDirectorAppointment'],
): void {
    const {
        acceptDirectorOutput,
        acceptMatchStartIntent,
        acceptMotionMessage,
        acceptPickup,
        acceptPlayerHit,
        activeMatchRoomIdRef,
        arenaMatchRef,
        bumpNetworkGeneration,
        connectionState,
        isCurrentNetworkGeneration,
        networkGenerationRef,
        roomId,
        runBestEffortNetworkTask,
        setDirectorStatus,
        setError,
        setGameDiagnostics,
    } = input;

    useEffect(() => {
        const previousRoomId = activeMatchRoomIdRef.current;
        const generation = previousRoomId || (connectionState === 'connected' && roomId)
            ? bumpNetworkGeneration()
            : networkGenerationRef.current;
        arenaMatchRef.current?.stop();
        arenaMatchRef.current = undefined;
        activeMatchRoomIdRef.current = undefined;
        if (connectionState !== 'connected' || !roomId) return;

        const match = createArenaMatchRuntime(input, generation, roomId);
        arenaMatchRef.current = match;
        activeMatchRoomIdRef.current = roomId;
        const unsubscribeStatus = match.onStatus(() => {
            setDirectorStatus(rallar.director.status(roomId));
            setGameDiagnostics(match.diagnostics());
        });

        let cancelled = false;
        void match.start()
            .then(async () => {
                if (
                    cancelled ||
                    arenaMatchRef.current !== match ||
                    !isCurrentNetworkGeneration(generation)
                ) return;
                setGameDiagnostics(match.diagnostics());
                await attemptDirectorAppointment('auto');
                if (
                    cancelled ||
                    arenaMatchRef.current !== match ||
                    !isCurrentNetworkGeneration(generation)
                ) return;
                setGameDiagnostics(match.diagnostics());
                await match.requestSync({ reason: 'arena-join' });
                runBestEffortNetworkTask(async () => {
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
                    if (
                        cancelled ||
                        arenaMatchRef.current !== match ||
                        !isCurrentNetworkGeneration(generation)
                    ) return;
                    setGameDiagnostics(match.diagnostics());
                    if (readiness.readyPeerIds.length > 0) {
                        await match.requestSync({ reason: 'arena-peer-ready' });
                    }
                }, generation);
            })
            .catch((error) => {
                if (isCurrentNetworkGeneration(generation)) {
                    setError(toErrorMessage(
                        error instanceof Error ? error : new Error(String(error)),
                    ));
                }
            });

        return () => {
            cancelled = true;
            unsubscribeStatus();
            match.stop();
            if (arenaMatchRef.current === match) arenaMatchRef.current = undefined;
        };
    }, [
        acceptDirectorOutput,
        acceptMatchStartIntent,
        acceptMotionMessage,
        acceptPickup,
        acceptPlayerHit,
        attemptDirectorAppointment,
        bumpNetworkGeneration,
        connectionState,
        isCurrentNetworkGeneration,
        roomId,
        runBestEffortNetworkTask,
    ]);
}
