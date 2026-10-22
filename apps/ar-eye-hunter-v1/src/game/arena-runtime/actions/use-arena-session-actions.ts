import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

import { rallar } from '@shared-web/browser/rallar.ts';
import type { RallarDirectorStatus, RallarRoomSummary } from '@shared-web/browser/rallar.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupDirectoryEntry } from '@shared/api/group-directory/group-directory-types.ts';
import { createRallarAiFunnyRoomName, createRallarAiRoomNameSeed } from '@shared/rallar-ai/mod.ts';

import { GAME_ROOM_NAME } from '../../types.ts';
import type {
    ArenaConnection,
    ArenaConnectionState,
    DirectorAttemptSource,
    DirectorAttemptState
} from '../arena-connection-contracts.ts';

const OPEN_ARENA_DIRECTORY_QUERY = 'eye hunter';
const OPEN_ARENA_DIRECTORY_PAGE_SIZE = 50;

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
    readonly directoryGenerationRef: RefObject<number>;
    readonly setConnectionState: Dispatch<SetStateAction<ArenaConnectionState>>;
    readonly setError: Dispatch<SetStateAction<string | undefined>>;
    readonly setRoomId: Dispatch<SetStateAction<string | undefined>>;
    readonly setOpenRooms: Dispatch<SetStateAction<readonly GroupDirectoryEntry[]>>;
    readonly setOpenRoomsError: Dispatch<SetStateAction<string | undefined>>;
    readonly setOpenRoomsStatus: Dispatch<SetStateAction<ArenaConnection['openRoomsStatus']>>;
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
    const pendingLogoutRef = useRef<Promise<void> | undefined>(undefined);
    const login = useCallback(
        (username: string, password: string) =>
            authenticateArena(
                input,
                { username, password, mode: 'login', displayName: undefined },
                pendingLogoutRef.current
            ),
        [input.connect]
    );
    const register = useCallback(
        (username: string, password: string, displayName?: string) =>
            authenticateArena(input, { username, password, displayName, mode: 'register' }, pendingLogoutRef.current),
        [input.connect]
    );
    const logout = useCallback(() => {
        pendingLogoutRef.current ??= logoutArena(input).finally(() => {
            pendingLogoutRef.current = undefined;
        });
        return pendingLogoutRef.current;
    }, [input.resetForSignedOutAuth]);
    return { login, register, logout };
}

async function logoutArena(input: ArenaSessionActionsInput): Promise<void> {
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
}

async function authenticateArena(
    input: ArenaSessionActionsInput,
    authentication: ArenaAuthentication,
    pendingLogout: Promise<void> | undefined
): Promise<void> {
    try {
        if (pendingLogout) {
            await pendingLogout;
        }
        input.setConnectionState('connecting');
        input.setError(undefined);
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

async function readOpenArenaDirectory(isCurrent: () => boolean): Promise<readonly GroupDirectoryEntry[] | undefined> {
    const entries = new Map<string, GroupDirectoryEntry>();
    let cursor: string | null = null;
    do {
        const page = await rallar.rooms.directory({
            kind: 'room',
            q: OPEN_ARENA_DIRECTORY_QUERY,
            limit: OPEN_ARENA_DIRECTORY_PAGE_SIZE,
            ...(cursor === null ? {} : { cursor })
        });
        if (!isCurrent()) {
            return undefined;
        }
        page.entries.forEach((entry) => entries.set(entry.groupRef.groupId, entry));
        cursor = page.nextCursor;
    }
    while (cursor !== null);
    return [...entries.values()];
}

async function refreshArenaRooms(input: ArenaSessionActionsInput): Promise<void> {
    const {
        sessionRef,
        directoryGenerationRef,
        setRooms,
        setRoomId,
        setOpenRooms,
        setOpenRoomsError,
        setOpenRoomsStatus
    } = input;
    const session = sessionRef.current;
    if (!session) {
        return;
    }
    const generation = ++directoryGenerationRef.current;
    const isCurrent = () =>
        directoryGenerationRef.current === generation &&
        sessionRef.current?.sessionId === session.sessionId && sessionRef.current?.clientId === session.clientId;
    setOpenRoomsStatus('loading');
    setOpenRoomsError(undefined);
    try {
        const state = await rallar.rooms.refresh();
        if (!isCurrent()) {
            return;
        }
        setRooms(state.rooms);
        setRoomId(state.currentRoomId);
        const openRooms = await readOpenArenaDirectory(isCurrent);
        if (!isCurrent() || !openRooms) {
            return;
        }
        setOpenRooms(openRooms);
        setOpenRoomsStatus('ready');
    }
    catch (error) {
        if (!isCurrent()) {
            return;
        }
        setOpenRoomsError(error instanceof Error ? error.message : String(error));
        setOpenRoomsStatus('error');
    }
}

function useArenaRoomActions(
    input: ArenaSessionActionsInput
): Pick<ArenaConnection, 'refreshRooms' | 'createArenaRoom' | 'joinRoom'> {
    const refreshRooms = useCallback(() => refreshArenaRooms(input), [
        input.sessionRef,
        input.directoryGenerationRef,
        input.setRooms,
        input.setRoomId,
        input.setOpenRooms,
        input.setOpenRoomsError,
        input.setOpenRoomsStatus
    ]);
    const createArenaRoom = useCallback(() => createAndSelectArenaRoom(input, refreshRooms), [
        input.sessionRef,
        input.setRoomId,
        input.clearRoomScopedArenaState,
        input.rooms,
        refreshRooms
    ]);
    const joinRoom = useCallback((roomId: string) => enterArenaRoom(input, refreshRooms, roomId), [
        input.sessionRef,
        input.setRoomId,
        input.clearRoomScopedArenaState,
        refreshRooms
    ]);
    return { refreshRooms, createArenaRoom, joinRoom };
}

async function createAndSelectArenaRoom(
    input: ArenaSessionActionsInput,
    refreshRooms: ArenaConnection['refreshRooms']
): Promise<void> {
    const { sessionRef, setRoomId, clearRoomScopedArenaState, rooms } = input;
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
        displayName,
        joinMode: 'open'
    });
    if (!sessionRef.current) {
        return;
    }
    clearRoomScopedArenaState();
    setRoomId(snapshot.group.groupId);
    await refreshRooms();
}

async function enterArenaRoom(
    input: ArenaSessionActionsInput,
    refreshRooms: ArenaConnection['refreshRooms'],
    nextRoomId: string
): Promise<void> {
    const { sessionRef, setRoomId, clearRoomScopedArenaState } = input;
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
