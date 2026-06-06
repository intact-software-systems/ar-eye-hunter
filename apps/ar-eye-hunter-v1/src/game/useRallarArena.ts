import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    rallar,
    type RallarDirectorRelayHandle,
    type RallarDirectorStatus,
    type RallarRoomSummary,
} from '@shared-web/browser/rallar.ts';
import { DEFAULT_REALTIME_DATA_CHANNEL_LANE } from '@shared-web/browser/middleware.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { RtcDataChannelLaneConfig } from '@shared/services/WebRtcConnectionService.ts';
import { shouldSendRallarMotionSample } from '@shared/rallar-motion/mod.ts';

import {
    GAME_DIRECTOR_HEARTBEAT_TYPE_ID,
    GAME_DIRECTOR_INTENT_TYPE_ID,
    GAME_DIRECTOR_OUTPUT_TYPE_ID,
    GAME_DIRECTOR_SNAPSHOT_TYPE_ID,
    GAME_DIRECTOR_SYNC_REQUEST_TYPE_ID,
    GAME_DIRECTOR_TOPIC_ID,
    GAME_LANE_ID,
    GAME_MOTION_LANE_ID,
    GAME_PROTOCOL,
    GAME_ROOM_NAME,
    type GameRealtimeMessage,
    type PlayerPose,
    type PlayerShot,
    type RemotePlayer,
    type RemoteShot,
} from './types.ts';
import { colorForId } from './color.ts';

type ConnectionState = 'signed-out' | 'connecting' | 'connected' | 'error';

const GAME_DATA_CHANNEL_LANES: readonly RtcDataChannelLaneConfig[] = [
    DEFAULT_REALTIME_DATA_CHANNEL_LANE,
    {
        id: GAME_MOTION_LANE_ID,
        label: 'rtc-motion',
        init: {
            ordered: false,
            maxRetransmits: 0,
        },
        binaryType: 'arraybuffer',
        flowControl: {
            highWatermarkBytes: 8 * 1024,
            lowWatermarkBytes: 2 * 1024,
            overflow: 'replace-by-key',
            maxQueueItems: 8,
        },
    },
];

export type ArenaConnection = Readonly<{
    session?: AuthSession;
    connectionState: ConnectionState;
    error?: string;
    roomId?: string;
    rooms: readonly RallarRoomSummary[];
    directorStatus: RallarDirectorStatus;
    remotePlayers: ReadonlyMap<string, RemotePlayer>;
    remoteShots: readonly RemoteShot[];
    login(username: string, password: string): Promise<void>;
    register(username: string, password: string, displayName?: string): Promise<void>;
    logout(): Promise<void>;
    refreshRooms(): Promise<void>;
    createArenaRoom(): Promise<void>;
    joinRoom(roomId: string): Promise<void>;
    appointSelfAsDirector(): Promise<void>;
    sendPose(pose: Omit<PlayerPose, 'sessionId' | 'username' | 'color'>): void;
    sendShot(shot: Omit<PlayerShot, 'sessionId' | 'username' | 'color'>): void;
}>;

export function useRallarArena(): ArenaConnection {
    const [session, setSession] = useState<AuthSession | undefined>(() =>
        rallar.auth.restore()
    );
    const [connectionState, setConnectionState] = useState<ConnectionState>(
        () => session ? 'connecting' : 'signed-out',
    );
    const [error, setError] = useState<string | undefined>();
    const [roomId, setRoomId] = useState<string | undefined>();
    const [rooms, setRooms] = useState<readonly RallarRoomSummary[]>([]);
    const [directorStatus, setDirectorStatus] = useState<RallarDirectorStatus>(
        () => rallar.director.status(),
    );
    const [remotePlayers, setRemotePlayers] = useState<
        ReadonlyMap<string, RemotePlayer>
    >(new Map());
    const [remoteShots, setRemoteShots] = useState<readonly RemoteShot[]>([]);

    const roomIdRef = useRef<string | undefined>(undefined);
    const sessionRef = useRef<AuthSession | undefined>(session);
    const directorStatusRef = useRef<RallarDirectorStatus>(directorStatus);
    const directorRelayRef = useRef<
        RallarDirectorRelayHandle<GameRealtimeMessage, GameRealtimeMessage, GameRealtimeMessage> | undefined
    >(undefined);
    const remotePlayersRef = useRef<ReadonlyMap<string, RemotePlayer>>(remotePlayers);
    const poseSendBudget = useRef(0);

    useEffect(() => {
        sessionRef.current = session;
    }, [session]);

    useEffect(() => {
        roomIdRef.current = roomId;
    }, [roomId]);

    useEffect(() => {
        directorStatusRef.current = directorStatus;
    }, [directorStatus]);

    useEffect(() => {
        remotePlayersRef.current = remotePlayers;
    }, [remotePlayers]);

    const acceptDirectorOutput = useCallback((
        message: GameRealtimeMessage,
    ) => {
        if (message.protocol !== GAME_PROTOCOL) {
            return;
        }

        const currentSessionId = sessionRef.current?.sessionId;
        if (message.kind === 'director-player-state') {
            const pose = message.pose;
            if (pose.sessionId === currentSessionId) {
                return;
            }

            setRemotePlayers((previous) => {
                const next = new Map(previous);
                const existing = next.get(pose.sessionId);
                if (existing && existing.pose.seq > pose.seq) {
                    return previous;
                }

                next.set(pose.sessionId, {
                    pose,
                    lastSeenEpochMs: Date.now(),
                });
                return next;
            });
            return;
        }

        if (message.kind === 'director-shot-event') {
            const shot = message.shot;
            if (shot.sessionId === currentSessionId) {
                return;
            }

            setRemoteShots((previous) => [
                ...previous.slice(-24),
                {
                    id: `${shot.sessionId}:${shot.seq}`,
                    shot,
                    receivedAtEpochMs: Date.now(),
                },
            ]);
            return;
        }

        if (message.kind === 'director-state-snapshot') {
            setRemotePlayers(new Map(
                message.players
                    .filter((pose) => pose.sessionId !== currentSessionId)
                    .map((pose) => [
                        pose.sessionId,
                        {
                            pose,
                            lastSeenEpochMs: Date.now(),
                        },
                    ]),
            ));
        }
    }, []);

    const acceptMotionMessage = useCallback((
        peerId: string,
        message: GameRealtimeMessage,
    ) => {
        if (message.protocol !== GAME_PROTOCOL) {
            return;
        }

        if (directorStatusRef.current.appointment) {
            return;
        }

        const currentSessionId = sessionRef.current?.sessionId;
        if (message.kind === 'player-pose') {
            const pose = message.pose;
            if (pose.sessionId === currentSessionId || pose.sessionId !== peerId) {
                return;
            }

            setRemotePlayers((previous) => {
                const next = new Map(previous);
                const existing = next.get(pose.sessionId);
                if (existing && existing.pose.seq > pose.seq) {
                    return previous;
                }

                next.set(pose.sessionId, {
                    pose,
                    lastSeenEpochMs: Date.now(),
                });
                return next;
            });
            return;
        }

        return;
    }, []);

    const acceptRealtimeMessage = useCallback((
        peerId: string,
        message: GameRealtimeMessage,
    ) => {
        if (message.protocol !== GAME_PROTOCOL) {
            return;
        }

        if (message.kind !== 'player-shot') {
            return;
        }

        const currentSessionId = sessionRef.current?.sessionId;

        const shot = message.shot;
        if (shot.sessionId === currentSessionId || shot.sessionId !== peerId) {
            return;
        }

        setRemoteShots((previous) => [
            ...previous.slice(-24),
            {
                id: `${shot.sessionId}:${shot.seq}`,
                shot,
                receivedAtEpochMs: Date.now(),
            },
        ]);
    }, []);

    const connect = useCallback(async () => {
        setConnectionState('connecting');
        setError(undefined);

        try {
            const startup = await rallar.start({
                refreshRooms: true,
                dataChannelLanes: GAME_DATA_CHANNEL_LANES,
            });
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
            setConnectionState('error');
            setError(toErrorMessage(err));
        }
    }, []);

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
                    GAME_LANE_ID,
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
                    [...previous].filter(([, remote]) =>
                        remote.lastSeenEpochMs >= cutoff
                    ),
                );
                return next.size === previous.size ? previous : next;
            });
        }, 2_000);
        subscriptions.add(() => window.clearInterval(prune));

        return () => subscriptions.unsubscribe();
    }, [acceptMotionMessage, acceptRealtimeMessage, connectionState]);

    useEffect(() => {
        directorRelayRef.current?.stop();
        directorRelayRef.current = undefined;

        if (connectionState !== 'connected' || !roomId) {
            return;
        }

        const relay = rallar.director.createRelay<
            GameRealtimeMessage,
            GameRealtimeMessage,
            GameRealtimeMessage
        >({
            roomId,
            laneId: GAME_LANE_ID,
            topicId: GAME_DIRECTOR_TOPIC_ID,
            intentTypeId: GAME_DIRECTOR_INTENT_TYPE_ID,
            outputTypeId: GAME_DIRECTOR_OUTPUT_TYPE_ID,
            heartbeatTypeId: GAME_DIRECTOR_HEARTBEAT_TYPE_ID,
            snapshotTypeId: GAME_DIRECTOR_SNAPSHOT_TYPE_ID,
            syncRequestTypeId: GAME_DIRECTOR_SYNC_REQUEST_TYPE_ID,
            heartbeatIntervalMs: 1_000,
            snapshotIntervalMs: 2_000,
            readSnapshot: () => ({
                protocol: GAME_PROTOCOL,
                kind: 'director-state-snapshot',
                players: [...remotePlayersRef.current.values()].map((remote) =>
                    remote.pose
                ),
                sentAtEpochMs: Date.now(),
            }),
            onIntent: (message) => {
                const data = message.data;
                if (data.protocol !== GAME_PROTOCOL) {
                    return;
                }

                if (data.kind === 'player-pose-intent') {
                    if (data.pose.sessionId !== message.senderId) {
                        return;
                    }
                    return {
                        protocol: GAME_PROTOCOL,
                        kind: 'director-player-state',
                        pose: data.pose,
                    };
                }

                if (data.kind === 'player-shot-intent') {
                    if (data.shot.sessionId !== message.senderId) {
                        return;
                    }
                    return {
                        protocol: GAME_PROTOCOL,
                        kind: 'director-shot-event',
                        shot: data.shot,
                    };
                }
            },
            onOutput: (message) => {
                acceptDirectorOutput(message.data);
            },
            onSnapshot: (message) => {
                acceptDirectorOutput(message.data);
            },
        });

        directorRelayRef.current = relay;
        setDirectorStatus(relay.status());
        void relay.requestSync();

        return () => {
            relay.stop();
            if (directorRelayRef.current === relay) {
                directorRelayRef.current = undefined;
            }
        };
    }, [acceptDirectorOutput, connectionState, roomId]);

    const refreshRooms = useCallback(async () => {
        const state = await rallar.rooms.refresh();
        setRooms(state.rooms);
        setRoomId(state.currentRoomId);
    }, []);

    const login = useCallback(async (username: string, password: string) => {
        setConnectionState('connecting');
        setError(undefined);
        try {
            const response = await rallar.auth.login({ username, password });
            setSession(response);
            await connect();
        } catch (err) {
            setConnectionState('error');
            setError(toErrorMessage(err));
        }
    }, [connect]);

    const register = useCallback(async (
        username: string,
        password: string,
        displayName?: string,
    ) => {
        setConnectionState('connecting');
        setError(undefined);
        try {
            const response = await rallar.auth.registerAndLogin({
                username,
                password,
                displayName: displayName || username,
            });
            setSession(response);
            await connect();
        } catch (err) {
            setConnectionState('error');
            setError(toErrorMessage(err));
        }
    }, [connect]);

    const logout = useCallback(async () => {
        await rallar.auth.logout();
        setSession(undefined);
        setRoomId(undefined);
        setRooms([]);
        setRemotePlayers(new Map());
        setRemoteShots([]);
        setConnectionState('signed-out');
    }, []);

    const createArenaRoom = useCallback(async () => {
        const snapshot = await rallar.rooms.create({
            displayName: GAME_ROOM_NAME,
        });
        setRoomId(snapshot.group.groupId);
        await refreshRooms();
    }, [refreshRooms]);

    const joinRoom = useCallback(async (nextRoomId: string) => {
        const snapshot = await rallar.rooms.join(nextRoomId);
        setRoomId(snapshot.group.groupId);
        await refreshRooms();
    }, [refreshRooms]);

    const appointSelfAsDirector = useCallback(async () => {
        const currentRoomId = roomIdRef.current;
        if (!currentRoomId) {
            return;
        }

        const status = await rallar.director.appoint(currentRoomId);
        setDirectorStatus(status);
    }, []);

    const sendPose = useCallback((
        pose: Omit<PlayerPose, 'sessionId' | 'username' | 'color'>,
    ) => {
        const currentSession = sessionRef.current;
        const currentRoomId = roomIdRef.current;
        if (!currentSession || !currentRoomId) {
            return;
        }

        const now = Date.now();
        if (!shouldSendRallarMotionSample(now, poseSendBudget.current, 50)) {
            return;
        }
        poseSendBudget.current = now + 50;

        const fullPose: PlayerPose = {
            ...pose,
            sessionId: currentSession.sessionId,
            username: currentSession.username,
            color: colorForId(currentSession.sessionId),
        };
        const currentDirector = directorStatusRef.current;
        if (currentDirector.appointment) {
            if (!currentDirector.isFresh) {
                return;
            }

            if (currentDirector.isDirector) {
                void directorRelayRef.current?.sendOutput({
                    protocol: GAME_PROTOCOL,
                    kind: 'director-player-state',
                    pose: fullPose,
                });
                return;
            }

            void directorRelayRef.current?.sendIntent({
                protocol: GAME_PROTOCOL,
                kind: 'player-pose-intent',
                pose: fullPose,
            });
            return;
        }

        void rallar.realtime.sendJson<GameRealtimeMessage>({
            laneId: GAME_MOTION_LANE_ID,
            roomId: currentRoomId,
            data: {
                protocol: GAME_PROTOCOL,
                kind: 'player-pose',
                pose: fullPose,
            },
            key: `pose:${currentSession.sessionId}`,
            maxAgeMs: 250,
            openTimeoutMs: 1500,
        });
    }, []);

    const sendShot = useCallback((
        shot: Omit<PlayerShot, 'sessionId' | 'username' | 'color'>,
    ) => {
        const currentSession = sessionRef.current;
        const currentRoomId = roomIdRef.current;
        if (!currentSession || !currentRoomId) {
            return;
        }

        const fullShot: PlayerShot = {
            ...shot,
            sessionId: currentSession.sessionId,
            username: currentSession.username,
            color: colorForId(currentSession.sessionId),
        };
        const currentDirector = directorStatusRef.current;
        if (currentDirector.appointment) {
            if (!currentDirector.isFresh) {
                return;
            }

            if (currentDirector.isDirector) {
                void directorRelayRef.current?.sendOutput({
                    protocol: GAME_PROTOCOL,
                    kind: 'director-shot-event',
                    shot: fullShot,
                });
                return;
            }

            void directorRelayRef.current?.sendIntent({
                protocol: GAME_PROTOCOL,
                kind: 'player-shot-intent',
                shot: fullShot,
            });
            return;
        }

        void rallar.realtime.sendJson<GameRealtimeMessage>({
            laneId: GAME_LANE_ID,
            roomId: currentRoomId,
            data: {
                protocol: GAME_PROTOCOL,
                kind: 'player-shot',
                shot: fullShot,
            },
            maxAgeMs: 1000,
            openTimeoutMs: 1500,
        });
    }, []);

    return useMemo(() => ({
        session,
        connectionState,
        error,
        roomId,
        rooms,
        directorStatus,
        remotePlayers,
        remoteShots,
        login,
        register,
        logout,
        refreshRooms,
        createArenaRoom,
        joinRoom,
        appointSelfAsDirector,
        sendPose,
        sendShot,
    }), [
        session,
        connectionState,
        error,
        roomId,
        rooms,
        directorStatus,
        remotePlayers,
        remoteShots,
        login,
        register,
        logout,
        refreshRooms,
        createArenaRoom,
        joinRoom,
        appointSelfAsDirector,
        sendPose,
        sendShot,
    ]);
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
