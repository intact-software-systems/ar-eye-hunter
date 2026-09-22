import { useCallback, useEffect } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

import { rallar } from '@shared-web/browser/rallar.ts';
import type { RallarDirectorStatus, RallarRoomSummary } from '@shared-web/browser/rallar.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { createRallarAiFunnyRoomName, createRallarAiRoomNameSeed } from '@shared/rallar-ai/mod.ts';

import { GAME_ROOM_NAME } from '../../types.ts';
import type {
    ArenaConnection,
    ArenaConnectionState,
    DirectorAttemptSource,
    DirectorAttemptState
} from '../arena-connection-contracts.ts';

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

interface ArenaAuthentication {
    readonly mode: 'login' | 'register';
    readonly username: string;
    readonly password: string;
    readonly displayName: string | undefined;
}

export function useArenaSessionActions(
    input: ArenaSessionActionsInput
): Pick<
    ArenaConnection,
    'login' | 'register' | 'logout' | 'refreshRooms' | 'createArenaRoom' | 'joinRoom' | 'appointSelfAsDirector'
> {
    const authentication = useArenaAuthentication(input);
    const rooms = useArenaRoomActions(input);
    const appointSelfAsDirector = useCallback(async () => {
        if (input.isNetworkEnabled()) {
            await input.attemptDirectorAppointment('manual');
        }
    }, [input.attemptDirectorAppointment, input.isNetworkEnabled]);
    useArenaAutomaticAppointment(input);
    return { ...authentication, ...rooms, appointSelfAsDirector };
}

function useArenaAuthentication(
    input: ArenaSessionActionsInput
): Pick<ArenaConnection, 'login' | 'register' | 'logout'> {
    const login = useCallback(
        (username: string, password: string) =>
            authenticateArena(input, { username, password, mode: 'login', displayName: undefined }),
        [input.connect]
    );
    const register = useCallback(
        (username: string, password: string, displayName?: string) =>
            authenticateArena(input, { username, password, displayName, mode: 'register' }),
        [input.connect]
    );
    const logout = useCallback(async () => {
        input.resetForSignedOutAuth();
        try {
            await rallar.auth.logout();
        }
        catch {
            // The facade already performed local cleanup; revocation is best effort.
        }
        finally {
            input.resetForSignedOutAuth();
        }
    }, [input.resetForSignedOutAuth]);
    return { login, register, logout };
}

async function authenticateArena(input: ArenaSessionActionsInput, authentication: ArenaAuthentication): Promise<void> {
    input.setConnectionState('connecting');
    input.setError(undefined);
    try {
        const session = authentication.mode === 'login'
            ? await rallar.auth.login({ username: authentication.username, password: authentication.password })
            : await rallar.auth.registerAndLogin({
                username: authentication.username,
                password: authentication.password,
                displayName: authentication.displayName || authentication.username
            });
        input.setSession(session);
        await input.connect();
    }
    catch (error) {
        input.setConnectionState('error');
        input.setError(error instanceof Error ? error.message : String(error));
    }
}

function useArenaRoomActions(
    input: ArenaSessionActionsInput
): Pick<ArenaConnection, 'refreshRooms' | 'createArenaRoom' | 'joinRoom'> {
    const { sessionRef, setRooms, setRoomId, clearRoomScopedArenaState, rooms } = input;
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

    return { refreshRooms, createArenaRoom, joinRoom };
}

function useArenaAutomaticAppointment(input: ArenaSessionActionsInput): void {
    const { connectionState, roomId, directorStatusRef, directorAttemptRef, roomIdRef, attemptDirectorAppointment } =
        input;
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
}
