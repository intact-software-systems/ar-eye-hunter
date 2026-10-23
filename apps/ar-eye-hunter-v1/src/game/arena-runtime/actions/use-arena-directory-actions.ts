import {
    useCallback,
    type Dispatch,
    type RefObject,
    type SetStateAction
} from 'react';

import { rallar, type RallarRoomSummary } from '@shared-web/browser/rallar.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupDirectoryEntry, GroupDirectoryOrder } from '@shared/api/group-directory/group-directory-types.ts';

import type { ArenaConnection } from '../arena-connection-contracts.ts';

export interface ArenaDirectoryActionsInput {
    readonly sessionRef: RefObject<AuthSession | undefined>;
    readonly directoryGenerationRef: RefObject<number>;
    readonly directoryOrderRef: RefObject<GroupDirectoryOrder>;
    readonly setDirectoryOrder: Dispatch<SetStateAction<GroupDirectoryOrder>>;
    readonly setRoomId: Dispatch<SetStateAction<string | undefined>>;
    readonly setOpenRooms: Dispatch<SetStateAction<readonly GroupDirectoryEntry[]>>;
    readonly setOpenRoomsError: Dispatch<SetStateAction<string | undefined>>;
    readonly setOpenRoomsStatus: Dispatch<SetStateAction<ArenaConnection['openRoomsStatus']>>;
    readonly setRooms: Dispatch<SetStateAction<readonly RallarRoomSummary[]>>;
}

export const OPEN_ARENA_DIRECTORY_QUERY = 'eye hunter';
const OPEN_ARENA_DIRECTORY_PAGE_SIZE = 50;

export function useArenaDirectoryActions(
    input: ArenaDirectoryActionsInput
): Pick<ArenaConnection, 'refreshRooms' | 'changeDirectoryOrder'> {
    const refreshRooms = useCallback(() => refreshArenaRooms(input), [
        input.sessionRef,
        input.directoryGenerationRef,
        input.directoryOrderRef,
        input.setRooms,
        input.setRoomId,
        input.setOpenRooms,
        input.setOpenRoomsError,
        input.setOpenRoomsStatus
    ]);
    const changeDirectoryOrder = useCallback(async (order: GroupDirectoryOrder) => {
        if (input.directoryOrderRef.current === order) {
            return;
        }
        input.directoryOrderRef.current = order;
        input.setDirectoryOrder(order);
        input.setOpenRooms([]);
        await refreshRooms();
    }, [input.directoryOrderRef, input.setDirectoryOrder, input.setOpenRooms, refreshRooms]);
    return { refreshRooms, changeDirectoryOrder };
}

async function readOpenArenaDirectory(
    order: GroupDirectoryOrder,
    isCurrent: () => boolean
): Promise<readonly GroupDirectoryEntry[] | undefined> {
    const entries = new Map<string, GroupDirectoryEntry>();
    let cursor: string | null = null;
    do {
        const page = await rallar.rooms.directory({
            kind: 'room',
            q: OPEN_ARENA_DIRECTORY_QUERY,
            limit: OPEN_ARENA_DIRECTORY_PAGE_SIZE,
            ...(order === 'online-members' ? {} : { order }),
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

async function refreshArenaRooms(input: ArenaDirectoryActionsInput): Promise<void> {
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
    const order = input.directoryOrderRef.current;
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
        const openRooms = await readOpenArenaDirectory(order, isCurrent);
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
