import type {
    Dispatch,
    RefObject,
    SetStateAction
} from 'react';
import {
    useCallback,
    useEffect,
    useRef
} from 'react';

import type {
    RallarCreateRoomInput,
    RallarDirectorStatus,
    RallarRoomSummary
} from '@shared-web/browser/rallar.ts';
import { rallar } from '@shared-web/browser/rallar.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupDirectoryListing } from '@shared/api/group-directory/group-directory-listing.ts';
import type { GroupJoinMode, GroupSnapshot } from '@shared/api/group-types.ts';
import type { QuickJoinGroupResult } from '@shared/api/mutation/group-quick-join.ts';
import { createRallarAiFunnyRoomName, createRallarAiRoomNameSeed } from '@shared/rallar-ai/mod.ts';

import { GAME_ROOM_NAME } from '../../arena-contracts.ts';
import type {
    ArenaConnection,
    ArenaConnectionState,
    DirectorAttemptSource,
    DirectorAttemptState
} from '../arena-connection-contracts.ts';
import { ARENA_ROOM_SCOPE, arenaRoomEntry } from '../arena-room-entry.ts';
import { ARENA_ROOM_NAME_THEME } from './arena-room-name-theme.ts';
import {
    OPEN_ARENA_DIRECTORY_QUERY,
    useArenaDirectoryActions,
    type ArenaDirectoryActionsInput
} from './use-arena-directory-actions.ts';

interface ArenaSessionActionsInput extends ArenaDirectoryActionsInput {
    readonly attemptDirectorAppointment: (source: DirectorAttemptSource) => Promise<void>;
    readonly clearRoomScopedArenaState: () => void;
    readonly connect: () => Promise<void>;
    readonly directorAttemptRef: RefObject<DirectorAttemptState>;
    readonly directorStatusRef: RefObject<RallarDirectorStatus>;
    readonly isNetworkEnabled: () => boolean;
    readonly resetForSignedOutAuth: () => void;
    readonly roomId: string | undefined;
    readonly roomIdRef: RefObject<string | undefined>;
    readonly rooms: readonly RallarRoomSummary[];
    readonly setConnectionState: Dispatch<SetStateAction<ArenaConnectionState>>;
    readonly setError: Dispatch<SetStateAction<string | undefined>>;
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
    | 'login'
    | 'register'
    | 'logout'
    | 'refreshRooms'
    | 'changeDirectoryOrder'
    | 'createArenaRoom'
    | 'quickJoinArenaRoom'
    | 'joinRoom'
    | 'watchRoom'
    | 'joinAsPlayer'
    | 'leaveRoom'
    | 'appointSelfAsDirector'
> {
    const authentication = useArenaAuthentication(input);
    const directory = useArenaDirectoryActions(input);
    const rooms = useArenaRoomActions(input, directory.refreshRooms);
    const appointSelfAsDirector = useCallback(async () => {
        if (input.isNetworkEnabled()) {
            await input.attemptDirectorAppointment('manual');
        }
    }, [input.attemptDirectorAppointment, input.isNetworkEnabled]);
    useArenaAutomaticAppointment(input);
    return { ...authentication, ...directory, ...rooms, appointSelfAsDirector };
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

function useArenaRoomActions(
    input: ArenaSessionActionsInput,
    refreshRooms: ArenaConnection['refreshRooms']
): Pick<
    ArenaConnection,
    'createArenaRoom' | 'quickJoinArenaRoom' | 'joinRoom' | 'watchRoom' | 'joinAsPlayer' | 'leaveRoom'
> {
    const createArenaRoom = useCallback(
        (joinMode: GroupJoinMode = 'open', directoryListing?: GroupDirectoryListing) =>
            createAndSelectArenaRoom(input, refreshRooms, {
                joinMode,
                ...(directoryListing === undefined ? {} : { directoryListing })
            }),
        [
            input.sessionRef,
            input.setRoomId,
            input.clearRoomScopedArenaState,
            input.rooms,
            refreshRooms
        ]
    );
    const joinRoom = useCallback((roomId: string) => enterArenaRoom(input, refreshRooms, roomId), [
        input.sessionRef,
        input.setRoomId,
        input.clearRoomScopedArenaState,
        refreshRooms
    ]);
    const quickJoinArenaRoom = useCallback(() => quickJoinArena(input, refreshRooms), [
        input.sessionRef,
        input.setRoomId,
        input.clearRoomScopedArenaState,
        refreshRooms
    ]);
    const watchRoom = useCallback(async (roomId: string) => {
        arenaRoomEntry.enter({
            roomRef: { ...ARENA_ROOM_SCOPE, groupId: roomId },
            joinCode: null,
            participation: 'spectator'
        });
        await arenaRoomEntry.resume();
        await refreshRooms();
    }, [refreshRooms]);
    const joinAsPlayer = useCallback(() => promoteArenaSpectator(input, refreshRooms), [input.roomIdRef, refreshRooms]);
    const leaveRoom = useCallback(() => leaveArenaRoom(input, refreshRooms), [input.roomIdRef, refreshRooms]);
    return { createArenaRoom, quickJoinArenaRoom, joinRoom, watchRoom, joinAsPlayer, leaveRoom };
}

async function quickJoinArena(
    input: ArenaSessionActionsInput,
    refreshRooms: ArenaConnection['refreshRooms']
): Promise<'joined' | 'unavailable' | undefined> {
    const session = input.sessionRef.current;
    if (!session) {
        return undefined;
    }
    arenaRoomEntry.cancel();
    const isCurrent = () =>
        input.sessionRef.current?.sessionId === session.sessionId &&
        input.sessionRef.current?.clientId === session.clientId;
    let result: QuickJoinGroupResult;
    try {
        result = await rallar.rooms.quickJoin({ kind: 'room', q: OPEN_ARENA_DIRECTORY_QUERY });
    }
    catch (error) {
        if (!isCurrent()) {
            return undefined;
        }
        if (
            error instanceof Error && error.name === 'RallarRoomSwitchPartialFailureError' &&
            'operation' in error && error.operation === 'quick-join'
        ) {
            adoptArenaRoom(input, rallar.rooms.state().currentRoomId);
            try {
                await refreshRooms();
            }
            finally {
                // The room is already current; retain the cleanup failure for the user even if refresh fails too.
                throw error;
            }
        }
        throw error;
    }
    if (!isCurrent()) {
        return undefined;
    }
    if (result.status === 'joined') {
        adoptArenaRoom(input, result.snapshot.group.groupId);
        await refreshRooms();
    }
    return result.status;
}

function adoptArenaRoom(input: ArenaSessionActionsInput, roomId: string | undefined): void {
    // The room subscription normally adopts first, while previous-room cleanup is still pending.
    if (input.roomIdRef.current !== roomId) {
        input.clearRoomScopedArenaState();
        input.roomIdRef.current = roomId;
        input.setRoomId(roomId);
    }
}

async function createAndSelectArenaRoom(
    input: ArenaSessionActionsInput,
    refreshRooms: ArenaConnection['refreshRooms'],
    options: Pick<RallarCreateRoomInput, 'joinMode' | 'directoryListing'>
): Promise<GroupSnapshot | undefined> {
    const { sessionRef, rooms } = input;
    const session = sessionRef.current;
    if (!session) {
        return undefined;
    }
    arenaRoomEntry.cancel();
    const displayName = createRallarAiFunnyRoomName({
        baseName: GAME_ROOM_NAME,
        theme: ARENA_ROOM_NAME_THEME,
        seed: createRallarAiRoomNameSeed('ar-eye-hunter'),
        existingNames: rooms.map((room) => room.name)
    });
    input.setError(undefined);
    let snapshot: GroupSnapshot;
    try {
        snapshot = await rallar.rooms.createAndSwitch({
            displayName,
            maxSpectators: 16,
            ...options,
            retention: { mode: 'temporary', reconnectGraceMs: 600_000 }
        });
    }
    catch (error) {
        if (sessionRef.current?.sessionId !== session.sessionId || sessionRef.current?.clientId !== session.clientId) {
            return undefined;
        }
        const admitted = rallar.rooms.state().currentRoom;
        if (
            !admitted || !(error instanceof Error) || error.name !== 'RallarRoomSwitchPartialFailureError' ||
            !('operation' in error) || error.operation !== 'create-and-switch'
        ) {
            throw error;
        }
        snapshot = admitted;
        input.setError('The new arena is ready, but leaving the previous arena failed. Your membership there remains.');
    }
    if (sessionRef.current?.sessionId !== session.sessionId || sessionRef.current?.clientId !== session.clientId) {
        return undefined;
    }
    adoptArenaRoom(input, snapshot.group.groupId);
    await refreshRooms();
    return snapshot;
}

async function enterArenaRoom(
    input: ArenaSessionActionsInput,
    refreshRooms: ArenaConnection['refreshRooms'],
    nextRoomId: string
): Promise<void> {
    const { sessionRef } = input;
    const session = sessionRef.current;
    if (!session) {
        return;
    }
    arenaRoomEntry.cancel();
    const room = await rallar.rooms.enter(nextRoomId);
    if (sessionRef.current?.sessionId !== session.sessionId || sessionRef.current?.clientId !== session.clientId) {
        return;
    }
    adoptArenaRoom(input, room.roomId);
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

async function promoteArenaSpectator(
    input: ArenaSessionActionsInput,
    refreshRooms: ArenaConnection['refreshRooms']
): Promise<void> {
    const roomId = input.roomIdRef.current;
    const session = input.sessionRef.current;
    if (!roomId || !session) {
        return;
    }
    input.setError(undefined);
    try {
        await rallar.rooms.join(roomId, { participation: 'player' });
        await refreshRooms();
    }
    catch (error) {
        if (input.roomIdRef.current === roomId && input.sessionRef.current === session) {
            input.setError(error instanceof Error ? error.message : String(error));
        }
    }
}

async function leaveArenaRoom(
    input: ArenaSessionActionsInput,
    refreshRooms: ArenaConnection['refreshRooms']
): Promise<void> {
    const roomId = input.roomIdRef.current;
    const session = input.sessionRef.current;
    if (!roomId || !session) {
        return;
    }
    input.setError(undefined);
    try {
        await rallar.rooms.leave(roomId);
        await refreshRooms();
    }
    catch (error) {
        if (input.roomIdRef.current === roomId && input.sessionRef.current === session) {
            input.setError(error instanceof Error ? error.message : String(error));
        }
    }
}
