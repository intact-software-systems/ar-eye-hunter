import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { rallar, type RallarRoomSummary } from '@shared-web/browser/rallar.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

import {
    GAME_LANE_ID,
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

export type ArenaConnection = Readonly<{
    session?: AuthSession;
    connectionState: ConnectionState;
    error?: string;
    roomId?: string;
    rooms: readonly RallarRoomSummary[];
    remotePlayers: ReadonlyMap<string, RemotePlayer>;
    remoteShots: readonly RemoteShot[];
    login(username: string, password: string): Promise<void>;
    register(username: string, password: string, displayName?: string): Promise<void>;
    logout(): Promise<void>;
    refreshRooms(): Promise<void>;
    createArenaRoom(): Promise<void>;
    joinRoom(roomId: string): Promise<void>;
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
    const [remotePlayers, setRemotePlayers] = useState<
        ReadonlyMap<string, RemotePlayer>
    >(new Map());
    const [remoteShots, setRemoteShots] = useState<readonly RemoteShot[]>([]);

    const roomIdRef = useRef<string | undefined>(undefined);
    const sessionRef = useRef<AuthSession | undefined>(session);
    const poseSendBudget = useRef(0);

    useEffect(() => {
        sessionRef.current = session;
    }, [session]);

    useEffect(() => {
        roomIdRef.current = roomId;
    }, [roomId]);

    const acceptRealtimeMessage = useCallback((
        peerId: string,
        message: GameRealtimeMessage,
    ) => {
        if (message.protocol !== GAME_PROTOCOL) {
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
        const restored = rallar.auth.restore();
        if (!restored) {
            setConnectionState('signed-out');
            setSession(undefined);
            return;
        }

        setConnectionState('connecting');
        setError(undefined);

        try {
            await rallar.connect();
            const roomState = await rallar.rooms.refresh();
            setSession(restored);
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

        const unsubscribeRealtime = rallar.realtime.onJson<GameRealtimeMessage>(
            GAME_LANE_ID,
            (message) => {
                acceptRealtimeMessage(message.peerId, message.data);
            },
        );
        const unsubscribeRooms = rallar.rooms.onChange((state) => {
            setRooms(state.rooms);
            setRoomId(state.currentRoomId);
        });

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

        return () => {
            unsubscribeRealtime();
            unsubscribeRooms();
            window.clearInterval(prune);
        };
    }, [acceptRealtimeMessage, connectionState]);

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

    const sendPose = useCallback((
        pose: Omit<PlayerPose, 'sessionId' | 'username' | 'color'>,
    ) => {
        const currentSession = sessionRef.current;
        const currentRoomId = roomIdRef.current;
        if (!currentSession || !currentRoomId) {
            return;
        }

        const now = Date.now();
        if (now < poseSendBudget.current) {
            return;
        }
        poseSendBudget.current = now + 50;

        void rallar.realtime.sendJson<GameRealtimeMessage>({
            laneId: GAME_LANE_ID,
            roomId: currentRoomId,
            data: {
                protocol: GAME_PROTOCOL,
                kind: 'player-pose',
                pose: {
                    ...pose,
                    sessionId: currentSession.sessionId,
                    username: currentSession.username,
                    color: colorForId(currentSession.sessionId),
                },
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

        void rallar.realtime.sendJson<GameRealtimeMessage>({
            laneId: GAME_LANE_ID,
            roomId: currentRoomId,
            data: {
                protocol: GAME_PROTOCOL,
                kind: 'player-shot',
                shot: {
                    ...shot,
                    sessionId: currentSession.sessionId,
                    username: currentSession.username,
                    color: colorForId(currentSession.sessionId),
                },
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
        remotePlayers,
        remoteShots,
        login,
        register,
        logout,
        refreshRooms,
        createArenaRoom,
        joinRoom,
        sendPose,
        sendShot,
    }), [
        session,
        connectionState,
        error,
        roomId,
        rooms,
        remotePlayers,
        remoteShots,
        login,
        register,
        logout,
        refreshRooms,
        createArenaRoom,
        joinRoom,
        sendPose,
        sendShot,
    ]);
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
