import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type Dispatch,
    type RefObject,
    type SetStateAction
} from 'react';

import { rallar, type RallarRoomSummary } from '@shared-web/browser/rallar.ts';
import { RallarRoomDirectory } from '@shared-web/browser/rooms/directory/rallar-room-directory.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupDirectoryEntry, GroupDirectoryOrder } from '@shared/api/group-directory/group-directory-types.ts';

import type { ArenaConnection, ArenaConnectionState } from '../arena-connection-contracts.ts';
import { ARENA_ROOM_SCOPE } from '../arena-room-entry.ts';

export interface ArenaDirectoryActionsInput {
    readonly connectionState: ArenaConnectionState;
    readonly sessionRef: RefObject<AuthSession | undefined>;
    readonly setDirectoryOrder: Dispatch<SetStateAction<GroupDirectoryOrder>>;
    readonly setRoomId: Dispatch<SetStateAction<string | undefined>>;
    readonly setOpenRooms: Dispatch<SetStateAction<readonly GroupDirectoryEntry[]>>;
    readonly setOpenRoomsError: Dispatch<SetStateAction<string | undefined>>;
    readonly setOpenRoomsStatus: Dispatch<SetStateAction<ArenaConnection['openRoomsStatus']>>;
    readonly setRooms: Dispatch<SetStateAction<readonly RallarRoomSummary[]>>;
}

export const OPEN_ARENA_DIRECTORY_QUERY = 'eye hunter';
const OPEN_ARENA_DIRECTORY_REQUEST: RallarRoomDirectory.Request = {
    kind: 'room',
    q: OPEN_ARENA_DIRECTORY_QUERY,
    limit: 50,
    includeEmpty: false,
    order: 'online-members'
};

export function useArenaDirectoryActions(
    input: ArenaDirectoryActionsInput
): Pick<ArenaConnection, 'refreshRooms' | 'changeDirectoryOrder'> {
    const [directory] = useState(() =>
        RallarRoomDirectory.createBrowser(rallar, {
            scope: ARENA_ROOM_SCOPE,
            request: OPEN_ARENA_DIRECTORY_REQUEST,
            refreshIntervalMs: 30_000,
            timeoutMs: 10_000,
            maxAttempts: 1
        })
    );
    const roomRefreshGeneration = useRef(0);
    useArenaDirectoryLifecycle(input, directory, roomRefreshGeneration);
    const refreshRooms = useCallback(() => refreshArenaRooms(input, directory, roomRefreshGeneration), [
        directory,
        input.sessionRef,
        input.setRooms,
        input.setRoomId,
        input.setOpenRoomsError,
        input.setOpenRoomsStatus
    ]);
    const changeDirectoryOrder = useCallback(async (order: GroupDirectoryOrder) => {
        input.setDirectoryOrder(order);
        await directory.changeRequest({ ...OPEN_ARENA_DIRECTORY_REQUEST, order });
    }, [directory, input.setDirectoryOrder]);
    return { refreshRooms, changeDirectoryOrder };
}

function useArenaDirectoryLifecycle(
    input: ArenaDirectoryActionsInput,
    directory: RallarRoomDirectory,
    roomRefreshGeneration: RefObject<number>
): void {
    const { connectionState, setOpenRooms, setOpenRoomsStatus, setOpenRoomsError } = input;
    useEffect(() => {
        if (connectionState !== 'connected') {
            return;
        }
        const unsubscribe = directory.onChange((state) => {
            setOpenRooms(state.entries);
            setOpenRoomsStatus(state.status);
            setOpenRoomsError(state.error);
        });
        void directory.start();
        return () => {
            roomRefreshGeneration.current += 1;
            unsubscribe();
            directory.stop();
        };
    }, [connectionState, directory, roomRefreshGeneration, setOpenRooms, setOpenRoomsStatus, setOpenRoomsError]);
}

async function refreshArenaRooms(
    input: ArenaDirectoryActionsInput,
    directory: RallarRoomDirectory,
    roomRefreshGeneration: RefObject<number>
): Promise<void> {
    const session = input.sessionRef.current;
    if (!session) {
        return;
    }
    const generation = ++roomRefreshGeneration.current;
    const isCurrent = () =>
        roomRefreshGeneration.current === generation &&
        input.sessionRef.current?.sessionId === session.sessionId &&
        input.sessionRef.current?.clientId === session.clientId;
    input.setOpenRoomsStatus('loading');
    input.setOpenRoomsError(undefined);
    try {
        const state = await rallar.rooms.refresh();
        if (!isCurrent()) {
            return;
        }
        input.setRooms(state.rooms);
        input.setRoomId(state.currentRoomId);
        await directory.refresh();
    }
    catch (error) {
        if (isCurrent()) {
            input.setOpenRoomsError(error instanceof Error ? error.message : String(error));
            input.setOpenRoomsStatus('error');
        }
    }
}
