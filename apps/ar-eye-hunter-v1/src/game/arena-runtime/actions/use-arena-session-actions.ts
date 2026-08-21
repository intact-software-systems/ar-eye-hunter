import { rallar } from '@shared-web/browser/rallar.ts';
import type { RallarDirectorStatus, RallarRoomSummary } from '@shared-web/browser/rallar.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { createRallarAiFunnyRoomName, createRallarAiRoomNameSeed } from '@shared/rallar-ai/mod.ts';
import { useCallback, useEffect } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

import { GAME_ROOM_NAME } from '../../types.ts';
import type {
    ArenaConnection,
    ArenaConnectionState,
    DirectorAttemptSource,
    DirectorAttemptState
} from '../arena-connection-contracts.ts';
import { toErrorMessage } from '../arena-connection-helpers.ts';

interface ArenaSessionActionsInput {
    readonly attemptDirectorAppointment: (source: DirectorAttemptSource) => Promise<void>;
    readonly clearRoomScopedArenaState: () => void;
    readonly connect: () => Promise<void>;
    readonly connectionState: ArenaConnectionState;
    readonly directorAttemptRef: RefObject<DirectorAttemptState>;
    readonly directorStatusRef: RefObject<RallarDirectorStatus>;
    readonly isNetworkEnabled: () => boolean;
    readonly resetForSignedOutAuth: () => void;
    readonly roomId: string | undefined;
    readonly roomIdRef: RefObject<string | undefined>;
    readonly rooms: readonly RallarRoomSummary[];
    readonly sessionRef: RefObject<AuthSession | undefined>;
    readonly setConnectionState: Dispatch<SetStateAction<ArenaConnectionState>>;
    readonly setError: Dispatch<SetStateAction<string | undefined>>;
    readonly setRoomId: Dispatch<SetStateAction<string | undefined>>;
    readonly setRooms: Dispatch<SetStateAction<readonly RallarRoomSummary[]>>;
    readonly setSession: Dispatch<SetStateAction<AuthSession | undefined>>;
}

export function useArenaSessionActions(
    input: ArenaSessionActionsInput
): Pick<
    ArenaConnection,
    | 'login'
    | 'register'
    | 'logout'
    | 'refreshRooms'
    | 'createArenaRoom'
    | 'joinRoom'
    | 'appointSelfAsDirector'
> {
    const {
        attemptDirectorAppointment,
        clearRoomScopedArenaState,
        connect,
        connectionState,
        directorAttemptRef,
        directorStatusRef,
        isNetworkEnabled,
        resetForSignedOutAuth,
        roomId,
        roomIdRef,
        rooms,
        sessionRef,
        setConnectionState,
        setError,
        setRoomId,
        setRooms,
        setSession
    } = input;

    const refreshRooms = useCallback(async () => {
        if (!sessionRef.current) {
            return;
        }
        const state = await rallar.rooms.refresh();
        if (!sessionRef.current) {
            return;
        }
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
        }
        catch (err) {
            setConnectionState('error');
            setError(toErrorMessage(err instanceof Error ? err : new Error(String(err))));
        }
    }, [connect]);

    const register = useCallback(async (
        username: string,
        password: string,
        displayName?: string
    ) => {
        setConnectionState('connecting');
        setError(undefined);
        try {
            const response = await rallar.auth.registerAndLogin({
                username,
                password,
                displayName: displayName || username
            });
            setSession(response);
            await connect();
        }
        catch (err) {
            setConnectionState('error');
            setError(toErrorMessage(err instanceof Error ? err : new Error(String(err))));
        }
    }, [connect]);

    const logout = useCallback(async () => {
        resetForSignedOutAuth();
        try {
            await rallar.auth.logout();
        }
        catch {
            // Manual logout is best-effort; the facade performs local cleanup first.
        }
        finally {
            resetForSignedOutAuth();
        }
    }, [resetForSignedOutAuth]);

    const createArenaRoom = useCallback(async () => {
        if (!sessionRef.current) {
            return;
        }
        const displayName = createRallarAiFunnyRoomName({
            baseName: GAME_ROOM_NAME,
            theme: 'ar-eye-hunter',
            seed: createRallarAiRoomNameSeed('ar-eye-hunter'),
            existingNames: rooms.map((room) => room.name)
        });
        const snapshot = await rallar.rooms.createAndSwitch({
            displayName
        });
        if (!sessionRef.current) {
            return;
        }
        clearRoomScopedArenaState();
        setRoomId(snapshot.group.groupId);
        await refreshRooms();
    }, [clearRoomScopedArenaState, refreshRooms, rooms]);

    const joinRoom = useCallback(async (nextRoomId: string) => {
        if (!sessionRef.current) {
            return;
        }
        const room = await rallar.rooms.enter(nextRoomId);
        if (!sessionRef.current) {
            return;
        }
        clearRoomScopedArenaState();
        setRoomId(room.roomId);
        await refreshRooms();
    }, [clearRoomScopedArenaState, refreshRooms]);

    const appointSelfAsDirector = useCallback(async () => {
        if (!isNetworkEnabled()) {
            return;
        }
        await attemptDirectorAppointment('manual');
    }, [attemptDirectorAppointment, isNetworkEnabled]);

    useEffect(() => {
        if (connectionState !== 'connected' || !roomId) {
            return;
        }
        const current = directorStatusRef.current;
        if (current.appointment) {
            return;
        }
        const timer = window.setTimeout(() => {
            const latest = directorStatusRef.current;
            const attempt = directorAttemptRef.current;
            if (
                !latest.appointment &&
                roomIdRef.current &&
                attempt.status !== 'pending' &&
                attempt.source !== 'auto'
            ) {
                void attemptDirectorAppointment('auto');
            }
        }, 750);
        return () => window.clearTimeout(timer);
    }, [attemptDirectorAppointment, connectionState, roomId]);

    return {
        login,
        register,
        logout,
        refreshRooms,
        createArenaRoom,
        joinRoom,
        appointSelfAsDirector
    };
}
