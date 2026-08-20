import { useCallback, useEffect } from 'react';
import { rallar } from '@shared-web/browser/rallar.ts';

import {
    GAME_AI_LANE_ID,
    GAME_COMBAT_LANE_ID,
    GAME_MOTION_LANE_ID,
    type GameRealtimeMessage,
} from '../../types.ts';
import { ARENA_RALLAR_GAME_DATA_CHANNEL_LANES } from '../../rallar-game-match-adapter.ts';
import type {
    ArenaConnectionLifecycle,
    ArenaConnectionLifecycleInput,
} from '../lifecycle/use-arena-connection-lifecycle.ts';
import { toErrorMessage } from '../arena-connection-helpers.ts';

export function useArenaConnectionSessionLifecycle(
    input: ArenaConnectionLifecycleInput,
): Pick<ArenaConnectionLifecycle, 'connect'> {
    const {
        acceptMotionMessage,
        acceptRealtimeMessage,
        bumpNetworkGeneration,
        connectionState,
        currentNetworkSignal,
        isCurrentNetworkGeneration,
        roomIdRef,
        setConnectionState,
        setDirectorStatus,
        setError,
        setRemotePlayers,
        setRoomId,
        setRooms,
        setSession,
    } = input;

    const connect = useCallback(async () => {
        const generation = bumpNetworkGeneration();
        const signal = currentNetworkSignal();
        setConnectionState('connecting');
        setError(undefined);

        try {
            const startup = await rallar.start({
                refreshRooms: true,
                dataChannelLanes: ARENA_RALLAR_GAME_DATA_CHANNEL_LANES,
                signal,
            });
            if (!isCurrentNetworkGeneration(generation) || signal.aborted) {
                return;
            }
            if (!startup.session || !startup.connected) {
                setConnectionState('signed-out');
                setSession(undefined);
                return;
            }

            const roomState = startup.roomState ?? rallar.rooms.state();
            setSession(startup.session);
            setRooms(roomState.rooms);
            setRoomId(roomState.currentRoomId);
            setConnectionState('connected');
        } catch (err) {
            if (!isCurrentNetworkGeneration(generation) || signal.aborted) {
                return;
            }
            setConnectionState('error');
            setError(toErrorMessage(err instanceof Error ? err : new Error(String(err))));
        }
    }, [bumpNetworkGeneration, currentNetworkSignal, isCurrentNetworkGeneration]);

    useEffect(() => {
        void connect();
    }, [connect]);

    useEffect(() => {
        if (connectionState !== 'connected') {
            return;
        }

        const subscriptions = rallar.subscriptions()
            .add(
                rallar.realtime.onJson<GameRealtimeMessage>(
                    GAME_MOTION_LANE_ID,
                    (message) => {
                        acceptMotionMessage(message.peerId, message.data);
                    },
                ),
            )
            .add(
                rallar.realtime.onJson<GameRealtimeMessage>(
                    GAME_COMBAT_LANE_ID,
                    (message) => {
                        acceptRealtimeMessage(message.peerId, message.data);
                    },
                ),
            )
            .add(
                rallar.realtime.onJson<GameRealtimeMessage>(
                    GAME_AI_LANE_ID,
                    (message) => {
                        acceptRealtimeMessage(message.peerId, message.data);
                    },
                ),
            )
            .add(
                rallar.rooms.onChange((state) => {
                    setRooms(state.rooms);
                    setRoomId(state.currentRoomId);
                    setDirectorStatus(
                        rallar.director.status(state.currentRoomRef),
                    );
                }),
            )
            .add(
                rallar.director.onStatus((status) => {
                    setDirectorStatus(status);
                }),
            );

        const directorPoll = window.setInterval(() => {
            const currentRoomId = roomIdRef.current;
            setDirectorStatus(rallar.director.status(currentRoomId));
        }, 1_000);
        subscriptions.add(() => window.clearInterval(directorPoll));

        const prune = window.setInterval(() => {
            const cutoff = Date.now() - 10_000;
            setRemotePlayers((previous) => {
                const next = new Map(
                    [...previous].filter(([, remote]) => remote.lastSeenEpochMs >= cutoff),
                );
                return next.size === previous.size ? previous : next;
            });
        }, 2_000);
        subscriptions.add(() => window.clearInterval(prune));

        return () => subscriptions.unsubscribe();
    }, [acceptMotionMessage, acceptRealtimeMessage, connectionState]);

    return { connect };
}
