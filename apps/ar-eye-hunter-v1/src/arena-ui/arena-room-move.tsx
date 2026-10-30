import { useRef, useState } from 'react';

import { RoomMovePanel } from '@shared-react/room-move-panel.tsx';
import { rallar } from '@shared-web/browser/rallar.ts';
import { RallarRoomMove } from '@shared-web/browser/rooms/move/rallar-room-move.ts';
import type { ArenaConnection } from '../game/arena-runtime/arena-connection-contracts.ts';
import { ARENA_ROOM_SCOPE } from '../game/arena-runtime/arena-room-entry.ts';

interface ArenaRoomMoveProps {
    readonly arena: ArenaConnection;
}

export function ArenaRoomMove({ arena }: ArenaRoomMoveProps) {
    const current = useRef(arena);
    current.current = arena;
    const [owner] = useState(() =>
        RallarRoomMove.createBrowser(rallar, async (_destination, run) => {
            const reason = toMoveBlocker(current.current);
            if (reason) {
                throw new Error(reason);
            }
            return await run();
        }, { scope: ARENA_ROOM_SCOPE, refreshIntervalMs: 15000 })
    );
    return (
        <RoomMovePanel
            people={rallar.people}
            owner={owner}
            scope={ARENA_ROOM_SCOPE}
            session={arena.session}
            roomId={arena.roomId}
            rooms={arena.rooms}
            destinations={arena.openRooms}
            connected={arena.connectionState === 'connected'}
            blockedReason={toMoveBlocker(arena)}
        />
    );
}

function toMoveBlocker(arena: ArenaConnection): string | null {
    if (arena.spectating) {
        return 'Spectators stay. Join as player before proposing or confirming a move.';
    }
    if (arena.arenaSnapshot?.match?.status === 'active') {
        return 'Finish the current match before moving together.';
    }
    return null;
}
