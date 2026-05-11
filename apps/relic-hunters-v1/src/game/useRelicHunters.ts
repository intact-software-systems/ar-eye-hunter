import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { rallar, type RallarRoomSummary } from '@shared-web/browser/rallar.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import {
    RELIC_PROTOCOL_VERSION,
    RELIC_TOPICS,
    RELIC_TYPES,
    type RelicActionInput,
    type RelicCharacterId,
    type RelicCommand,
    type RelicPublicSnapshot,
    type RelicServerEvent,
    isRelicSnapshot,
} from '@relic-hunters/mod.ts';
import { fetchRelicSnapshot, resetRelicGame, sendRelicCommand } from './api.ts';

const ROOM_NAME = 'Relic Hunters Expedition';

type ConnectionState = 'signed-out' | 'connecting' | 'connected' | 'error';
type RelicCommandDraft =
    | Readonly<{ kind: 'join-expedition'; characterId?: RelicCharacterId }>
    | Readonly<{ kind: 'start-expedition' }>
    | Readonly<{ kind: 'submit-action'; action: RelicActionInput }>
    | Readonly<{ kind: 'set-round-limit'; timeLimitMs: number }>;

export type RelicHuntersConnection = Readonly<{
    session?: AuthSession;
    connectionState: ConnectionState;
    error?: string;
    roomId?: string;
    rooms: readonly RallarRoomSummary[];
    snapshot?: RelicPublicSnapshot;
    login(username: string, password: string): Promise<void>;
    register(username: string, password: string, displayName?: string): Promise<void>;
    logout(): Promise<void>;
    refreshRooms(): Promise<void>;
    createRoom(): Promise<void>;
    joinRoom(roomId: string): Promise<void>;
    joinExpedition(characterId?: RelicCharacterId): Promise<void>;
    startExpedition(): Promise<void>;
    submitAction(action: RelicActionInput): Promise<void>;
    setRoundLimit(timeLimitMs: number): Promise<void>;
    resetExpedition(): Promise<void>;
}>;

export function useRelicHunters(): RelicHuntersConnection {
    const [session, setSession] = useState<AuthSession | undefined>(() =>
        rallar.auth.restore()
    );
    const [connectionState, setConnectionState] = useState<ConnectionState>(
        () => session ? 'connecting' : 'signed-out',
    );
    const [error, setError] = useState<string | undefined>();
    const [roomId, setRoomId] = useState<string | undefined>();
    const [rooms, setRooms] = useState<readonly RallarRoomSummary[]>([]);
    const [snapshot, setSnapshot] = useState<RelicPublicSnapshot | undefined>();
    const sessionRef = useRef<AuthSession | undefined>(session);
    const roomIdRef = useRef<string | undefined>(roomId);

    useEffect(() => {
        sessionRef.current = session;
    }, [session]);

    useEffect(() => {
        roomIdRef.current = roomId;
    }, [roomId]);

    const acceptSnapshot = useCallback((value: unknown) => {
        const next = isRelicServerEvent(value) ? value.snapshot : value;
        if (!isRelicSnapshot(next)) {
            return;
        }

        setSnapshot(next);
    }, []);

    const connect = useCallback(async () => {
        const restored = rallar.auth.restore();
        if (!restored) {
            setSession(undefined);
            setConnectionState('signed-out');
            return;
        }

        setConnectionState('connecting');
        setError(undefined);
        try {
            await rallar.connect();
            const roomState = await rallar.rooms.refresh();
            const nextRoomId = roomState.currentRoomId;
            setSession(restored);
            setRooms(roomState.rooms);
            setRoomId(nextRoomId);
            setConnectionState('connected');
            if (nextRoomId) {
                setSnapshot(await fetchRelicSnapshot(nextRoomId));
            }
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

        const unsubscribeSnapshots = rallar.messages.ws.onMessage<RelicServerEvent>(
            {
                topicId: RELIC_TOPICS.snapshot,
                typeId: RELIC_TYPES.snapshot,
            },
            (message) => acceptSnapshot(message.payload),
        );
        const unsubscribeRooms = rallar.rooms.onChange((state) => {
            setRooms(state.rooms);
            setRoomId(state.currentRoomId);
        });

        return () => {
            unsubscribeSnapshots();
            unsubscribeRooms();
        };
    }, [acceptSnapshot, connectionState]);

    useEffect(() => {
        if (!session || !roomId || connectionState !== 'connected') {
            setSnapshot(undefined);
            return;
        }

        let active = true;
        fetchRelicSnapshot(roomId)
            .then((next) => {
                if (active) {
                    setSnapshot(next);
                }
            })
            .catch((err) => {
                if (active) {
                    setError(toErrorMessage(err));
                }
            });

        return () => {
            active = false;
        };
    }, [connectionState, roomId, session]);

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
        setSnapshot(undefined);
        setConnectionState('signed-out');
    }, []);

    const createRoom = useCallback(async () => {
        const created = await rallar.rooms.create({
            displayName: ROOM_NAME,
        });
        setRoomId(created.group.groupId);
        setSnapshot(await fetchRelicSnapshot(created.group.groupId));
        await refreshRooms();
    }, [refreshRooms]);

    const joinRoom = useCallback(async (nextRoomId: string) => {
        const joined = await rallar.rooms.join(nextRoomId);
        setRoomId(joined.group.groupId);
        setSnapshot(await fetchRelicSnapshot(joined.group.groupId));
        await refreshRooms();
    }, [refreshRooms]);

    const sendCommand = useCallback(async (
        input: RelicCommandDraft,
    ) => {
        const currentSession = sessionRef.current;
        const currentRoomId = roomIdRef.current;
        if (!currentSession || !currentRoomId) {
            return;
        }
        setError(undefined);

        const command = {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            gameId: currentRoomId,
            username: currentSession.username,
            ...input,
        } as RelicCommand;

        try {
            setSnapshot(await sendRelicCommand(currentRoomId, command));
        } catch (err) {
            setError(toErrorMessage(err));
        }
    }, []);

    const joinExpedition = useCallback(async (characterId?: RelicCharacterId) => {
        await sendCommand({ kind: 'join-expedition', characterId });
    }, [sendCommand]);

    const startExpedition = useCallback(async () => {
        await sendCommand({ kind: 'start-expedition' });
    }, [sendCommand]);

    const submitAction = useCallback(async (action: RelicActionInput) => {
        await sendCommand({
            kind: 'submit-action',
            action,
        });
    }, [sendCommand]);

    const setRoundLimit = useCallback(async (timeLimitMs: number) => {
        await sendCommand({ kind: 'set-round-limit', timeLimitMs });
    }, [sendCommand]);

    const resetExpedition = useCallback(async () => {
        const currentRoomId = roomIdRef.current;
        if (!currentRoomId) {
            return;
        }

        setSnapshot(await resetRelicGame(currentRoomId));
    }, []);

    return useMemo(() => ({
        session,
        connectionState,
        error,
        roomId,
        rooms,
        snapshot,
        login,
        register,
        logout,
        refreshRooms,
        createRoom,
        joinRoom,
        joinExpedition,
        startExpedition,
        submitAction,
        setRoundLimit,
        resetExpedition,
    }), [
        session,
        connectionState,
        error,
        roomId,
        rooms,
        snapshot,
        login,
        register,
        logout,
        refreshRooms,
        createRoom,
        joinRoom,
        joinExpedition,
        startExpedition,
        submitAction,
        setRoundLimit,
        resetExpedition,
    ]);
}

function isRelicServerEvent(value: unknown): value is RelicServerEvent {
    return typeof value === 'object' &&
        value !== null &&
        'snapshot' in value;
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
