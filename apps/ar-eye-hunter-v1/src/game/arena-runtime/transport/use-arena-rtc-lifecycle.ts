import { useEffect } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { rallar } from '@shared-web/browser/rallar.ts';
import type { RallarGameDiagnostics } from '@shared-web/game/mod.ts';

import {
    GAME_AI_LANE_ID,
    GAME_COMBAT_LANE_ID,
    GAME_FX_LANE_ID,
    GAME_MOTION_LANE_ID,
    type RtcLaneStatus,
} from '../../types.ts';
import { GAME_SNAPSHOT_LANE_ID } from '../../rallar-game-match-adapter.ts';
import type { ArenaRallarGameMatchHandle } from '../../rallar-game-match-adapter.ts';
import type { ArenaConnectionState } from '../arena-connection-contracts.ts';

interface ArenaRtcLifecycleInput {
    readonly arenaMatchRef: RefObject<ArenaRallarGameMatchHandle | undefined>;
    readonly connectionState: ArenaConnectionState;
    readonly isCurrentNetworkGeneration: (generation: number) => boolean;
    readonly isNetworkEnabled: () => boolean;
    readonly networkGenerationRef: RefObject<number>;
    readonly roomId: string | undefined;
    readonly rtcLanes: readonly RtcLaneStatus[];
    readonly runBestEffortNetworkTask: <T>(
        task: () => Promise<T> | undefined,
        generation?: number,
    ) => void;
    readonly setGameDiagnostics: Dispatch<SetStateAction<RallarGameDiagnostics | undefined>>;
    readonly setRtcLanes: Dispatch<SetStateAction<readonly RtcLaneStatus[]>>;
    readonly snapshotLaneReadySyncKeyRef: RefObject<string | undefined>;
}

export function useArenaRtcLifecycle(input: ArenaRtcLifecycleInput): void {
    const {
        arenaMatchRef,
        connectionState,
        isCurrentNetworkGeneration,
        isNetworkEnabled,
        networkGenerationRef,
        roomId,
        rtcLanes,
        runBestEffortNetworkTask,
        setGameDiagnostics,
        setRtcLanes,
        snapshotLaneReadySyncKeyRef,
    } = input;

    useEffect(() => {
        if (connectionState !== 'connected' || !roomId) {
            setRtcLanes([]);
            return;
        }

        let cancelled = false;
        const laneIds = [
            GAME_MOTION_LANE_ID,
            GAME_COMBAT_LANE_ID,
            GAME_SNAPSHOT_LANE_ID,
            GAME_FX_LANE_ID,
            GAME_AI_LANE_ID,
        ] as const;
        const generation = networkGenerationRef.current;
        const controller = new AbortController();
        const signal = controller.signal;

        const refresh = async () => {
            if (!isCurrentNetworkGeneration(generation) || signal.aborted) {
                return;
            }
            const next: RtcLaneStatus[] = [];
            for (const laneId of laneIds) {
                if (!isCurrentNetworkGeneration(generation) || signal.aborted) {
                    return;
                }
                try {
                    const readiness = await rallar.rtc.waitForRoomLane(roomId, laneId, {
                        connect: true,
                        timeoutMs: 650,
                        signal,
                    });
                    next.push({
                        laneId,
                        status: readiness.status === 'open' || readiness.status === 'partial'
                            ? readiness.status
                            : readiness.ready.length > 0
                            ? 'partial'
                            : 'closed',
                        readyPeers: readiness.ready.length,
                        notReadyPeers: readiness.notReady.length,
                    });
                } catch {
                    next.push({
                        laneId,
                        status: 'unavailable',
                        readyPeers: 0,
                        notReadyPeers: 0,
                    });
                }
            }
            if (!cancelled && isCurrentNetworkGeneration(generation) && !signal.aborted) {
                setRtcLanes(next);
            }
        };

        void refresh();
        const interval = window.setInterval(() => void refresh(), 2_500);
        return () => {
            cancelled = true;
            controller.abort();
            window.clearInterval(interval);
        };
    }, [connectionState, isCurrentNetworkGeneration, roomId]);

    useEffect(() => {
        if (!isNetworkEnabled()) {
            snapshotLaneReadySyncKeyRef.current = undefined;
            return;
        }

        const snapshotLane = rtcLanes.find((lane) => lane.laneId === GAME_SNAPSHOT_LANE_ID);
        if (!snapshotLane || snapshotLane.readyPeers < 1) {
            return;
        }

        const generation = networkGenerationRef.current;
        const syncKey = `${generation}:${snapshotLane.readyPeers}`;
        if (snapshotLaneReadySyncKeyRef.current === syncKey) {
            return;
        }
        snapshotLaneReadySyncKeyRef.current = syncKey;

        const match = arenaMatchRef.current;
        if (!match) {
            return;
        }

        runBestEffortNetworkTask(async () => {
            const readiness = await match.waitForReadyLanes({
                laneIds: [GAME_SNAPSHOT_LANE_ID],
                expect: { min: 1 },
                timeoutMs: 650,
            });
            if (
                arenaMatchRef.current !== match ||
                !isCurrentNetworkGeneration(generation)
            ) {
                return;
            }
            setGameDiagnostics(match.diagnostics());
            if (readiness.readyPeerIds.length > 0) {
                await match.requestSync({ reason: 'arena-peer-ready' });
            }
        }, generation);
    }, [
        isCurrentNetworkGeneration,
        isNetworkEnabled,
        rtcLanes,
        runBestEffortNetworkTask,
    ]);
}
