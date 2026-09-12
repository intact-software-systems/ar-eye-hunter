import { useCallback, useEffect } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

import { rallar } from '@shared-web/browser/rallar.ts';
import type { RallarDirectorStatus, RallarRoomSummary } from '@shared-web/browser/rallar.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

import { ARENA_RALLAR_GAME_DATA_CHANNEL_LANES } from '../../rallar-game-match-adapter.ts';
import { GAME_AI_LANE_ID, GAME_COMBAT_LANE_ID, GAME_MOTION_LANE_ID, type GameRealtimeMessage } from '../../types.ts';
import type { RemotePlayer } from '../../types.ts';
import type { ArenaConnectionState } from '../arena-connection-contracts.ts';

interface ArenaConnectionSessionLifecycleInput {
    readonly nowMs: () => number;
    readonly acceptMotionMessage: (senderId: string, message: GameRealtimeMessage) => void;
    readonly acceptRealtimeMessage: (senderId: string, message: GameRealtimeMessage) => void;
    readonly bumpNetworkGeneration: () => number;
    readonly connectionState: ArenaConnectionState;
    readonly currentNetworkSignal: () => AbortSignal;
    readonly isCurrentNetworkGeneration: (generation: number) => boolean;
    readonly roomIdRef: RefObject<string | undefined>;
    readonly setConnectionState: Dispatch<SetStateAction<ArenaConnectionState>>;
    readonly setDirectorStatus: Dispatch<SetStateAction<RallarDirectorStatus>>;
    readonly setError: Dispatch<SetStateAction<string | undefined>>;
    readonly setRemotePlayers: Dispatch<SetStateAction<ReadonlyMap<string, RemotePlayer>>>;
    readonly setRoomId: Dispatch<SetStateAction<string | undefined>>;
    readonly setRooms: Dispatch<SetStateAction<readonly RallarRoomSummary[]>>;
    readonly setSession: Dispatch<SetStateAction<AuthSession | undefined>>;
}

interface ArenaConnectionSessionActions {
    connect(): Promise<void>;
}

export function useArenaConnectionSessionLifecycle(
    input: ArenaConnectionSessionLifecycleInput
): ArenaConnectionSessionActions {
    const connect = useCallback(() => connectArenaSession(input), [
        input.bumpNetworkGeneration,
        input.currentNetworkSignal,
        input.isCurrentNetworkGeneration
    ]);
    useEffect(() => {
        void connect();
    }, [connect]);
    useEffect(() => {
        if (input.connectionState !== 'connected') {
            return;
        }
        return startArenaSessionSubscriptions(input);
    }, [input.acceptMotionMessage, input.acceptRealtimeMessage, input.connectionState]);
    return { connect };
}

async function connectArenaSession(input: ArenaConnectionSessionLifecycleInput): Promise<void> {
    const generation = input.bumpNetworkGeneration();
    const signal = input.currentNetworkSignal();
    input.setConnectionState('connecting');
    input.setError(undefined);

    try {
        const startup = await rallar.start({
            refreshRooms: true,
            dataChannelLanes: ARENA_RALLAR_GAME_DATA_CHANNEL_LANES,
            signal
        });
        if (!input.isCurrentNetworkGeneration(generation) || signal.aborted) {
            return;
        }
        if (!startup.session || !startup.connected) {
            input.setConnectionState('signed-out');
            input.setSession(undefined);
            return;
        }

        const roomState = startup.roomState ?? rallar.rooms.state();
        input.setSession(startup.session);
        input.setRooms(roomState.rooms);
        input.setRoomId(roomState.currentRoomId);
        input.setConnectionState('connected');
    }
    catch (err) {
        if (!input.isCurrentNetworkGeneration(generation) || signal.aborted) {
            return;
        }
        input.setConnectionState('error');
        input.setError(err instanceof Error ? err.message : String(err));
    }
}

function startArenaSessionSubscriptions(input: ArenaConnectionSessionLifecycleInput): () => void {
    const subscriptions = rallar.subscriptions()
        .add(
            rallar.realtime.onJson<GameRealtimeMessage>(
                GAME_MOTION_LANE_ID,
                (message) => {
                    input.acceptMotionMessage(message.peerId, message.data);
                }
            )
        )
        .add(
            rallar.realtime.onJson<GameRealtimeMessage>(
                GAME_COMBAT_LANE_ID,
                (message) => {
                    input.acceptRealtimeMessage(message.peerId, message.data);
                }
            )
        )
        .add(
            rallar.realtime.onJson<GameRealtimeMessage>(
                GAME_AI_LANE_ID,
                (message) => {
                    input.acceptRealtimeMessage(message.peerId, message.data);
                }
            )
        )
        .add(
            rallar.rooms.onChange((state) => {
                input.setRooms(state.rooms);
                input.setRoomId(state.currentRoomId);
                input.setDirectorStatus(
                    rallar.director.status(state.currentRoomRef)
                );
            })
        )
        .add(
            rallar.director.onStatus((status) => {
                input.setDirectorStatus(status);
            })
        );

    registerArenaSessionTimers(input, subscriptions);
    return () => subscriptions.unsubscribe();
}

function registerArenaSessionTimers(
    input: ArenaConnectionSessionLifecycleInput,
    subscriptions: ReturnType<typeof rallar.subscriptions>
): void {
    const directorPoll = window.setInterval(() => {
        const currentRoomId = input.roomIdRef.current;
        input.setDirectorStatus(rallar.director.status(currentRoomId));
    }, 1_000);
    subscriptions.add(() => window.clearInterval(directorPoll));

    const prune = window.setInterval(() => {
        const cutoff = input.nowMs() - 10_000;
        input.setRemotePlayers((previous) => {
            const next = new Map(
                [...previous].filter(([, remote]) => remote.lastSeenEpochMs >= cutoff)
            );
            return next.size === previous.size ? previous : next;
        });
    }, 2_000);
    subscriptions.add(() => window.clearInterval(prune));
}
