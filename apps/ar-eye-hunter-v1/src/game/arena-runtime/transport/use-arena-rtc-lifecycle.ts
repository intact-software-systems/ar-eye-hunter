import { rallar } from '@shared-web/browser/rallar.ts';
import type { RallarGameDiagnostics } from '@shared-web/game/mod.ts';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useEffect } from 'react';

import {
    GAME_AI_LANE_ID,
    GAME_COMBAT_LANE_ID,
    GAME_FX_LANE_ID,
    GAME_MOTION_LANE_ID,
    type RtcLaneStatus
} from '../../arena-contracts.ts';
import type { ArenaRallarGameMatchHandle } from '../../rallar-game-match-adapter.ts';
import { GAME_SNAPSHOT_LANE_ID } from '../../rallar-game-match-adapter.ts';
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
        generation?: number
    ) => void;
    readonly setGameDiagnostics: Dispatch<SetStateAction<RallarGameDiagnostics | undefined>>;
    readonly setRtcLanes: Dispatch<SetStateAction<readonly RtcLaneStatus[]>>;
    readonly snapshotLaneReadySyncKeyRef: RefObject<string | undefined>;
}
const ARENA_RTC_LANE_IDS = [
    GAME_MOTION_LANE_ID,
    GAME_COMBAT_LANE_ID,
    GAME_SNAPSHOT_LANE_ID,
    GAME_FX_LANE_ID,
    GAME_AI_LANE_ID
] as const;

export function useArenaRtcLifecycle(input: ArenaRtcLifecycleInput): void {
    useArenaRtcLaneReadiness(input);
    useArenaSnapshotLaneSync(input);
}
function useArenaRtcLaneReadiness(input: ArenaRtcLifecycleInput): void {
    useEffect(() => {
        if (input.connectionState !== 'connected' || !input.roomId) {
            input.setRtcLanes([]);
            return;
        }

        return startArenaRtcLaneReadiness(input, input.roomId);
    }, [input.connectionState, input.isCurrentNetworkGeneration, input.roomId]);
}
function useArenaSnapshotLaneSync(input: ArenaRtcLifecycleInput): void {
    useEffect(() => {
        if (!input.isNetworkEnabled()) {
            input.snapshotLaneReadySyncKeyRef.current = undefined;
            return;
        }

        const snapshotLane = input.rtcLanes.find((lane) => lane.laneId === GAME_SNAPSHOT_LANE_ID);
        if (!snapshotLane || snapshotLane.readyPeers < 1) {
            return;
        }

        const generation = input.networkGenerationRef.current;
        const syncKey = `${generation}:${snapshotLane.readyPeers}`;
        if (input.snapshotLaneReadySyncKeyRef.current === syncKey) {
            return;
        }
        input.snapshotLaneReadySyncKeyRef.current = syncKey;

        const match = input.arenaMatchRef.current;
        if (!match) {
            return;
        }

        input.runBestEffortNetworkTask(async () => {
            const readiness = await match.waitForReadyLanes({
                laneIds: [GAME_SNAPSHOT_LANE_ID],
                expect: { min: 1 },
                timeoutMs: 650
            });
            if (
                input.arenaMatchRef.current !== match ||
                !input.isCurrentNetworkGeneration(generation)
            ) {
                return;
            }
            input.setGameDiagnostics(match.diagnostics());
            if (readiness.readyPeerIds.length > 0) {
                await match.requestSync({ reason: 'arena-peer-ready' });
            }
        }, generation);
    }, [
        input.isCurrentNetworkGeneration,
        input.isNetworkEnabled,
        input.rtcLanes,
        input.runBestEffortNetworkTask
    ]);
}
function startArenaRtcLaneReadiness(input: ArenaRtcLifecycleInput, roomId: string): () => void {
    const generation = input.networkGenerationRef.current;
    const controller = new AbortController();
    const signal = controller.signal;

    const refresh = () => refreshArenaRtcLanes({ lifecycle: input, roomId, generation, signal });

    void refresh();
    const interval = window.setInterval(() => void refresh(), 2_500);
    return () => {
        controller.abort();
        window.clearInterval(interval);
    };
}
interface ArenaRtcLaneRefresh {
    readonly lifecycle: ArenaRtcLifecycleInput;
    readonly roomId: string;
    readonly generation: number;
    readonly signal: AbortSignal;
}
async function refreshArenaRtcLanes(
    { lifecycle: input, roomId, generation, signal }: ArenaRtcLaneRefresh
): Promise<void> {
    if (!input.isCurrentNetworkGeneration(generation) || signal.aborted) {
        return;
    }
    const next: RtcLaneStatus[] = [];
    for (const laneId of ARENA_RTC_LANE_IDS) {
        if (!input.isCurrentNetworkGeneration(generation) || signal.aborted) {
            return;
        }
        try {
            const readiness = await rallar.rtc.waitForRoomLane(roomId, laneId, {
                connect: true,
                timeoutMs: 650,
                signal
            });
            next.push({
                laneId,
                status: readiness.status === 'open' || readiness.status === 'partial'
                    ? readiness.status
                    : readiness.ready.length > 0
                    ? 'partial'
                    : 'closed',
                readyPeers: readiness.ready.length,
                notReadyPeers: readiness.notReady.length
            });
        }
        catch {
            next.push({
                laneId,
                status: 'unavailable',
                readyPeers: 0,
                notReadyPeers: 0
            });
        }
    }
    if (input.isCurrentNetworkGeneration(generation) && !signal.aborted) {
        input.setRtcLanes(next);
    }
}
