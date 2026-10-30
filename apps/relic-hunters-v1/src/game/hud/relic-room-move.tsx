import { hasUnfinishedRelicParticipation } from '@relic-hunters/mod.ts';
import { rallar } from '@shared-web/browser/rallar.ts';
import { RoomMovePanel } from '@shared-web/react/room-move-panel.tsx';
import { RELIC_ROOM_SCOPE } from '../relic-hunters-browser.ts';
import type { RelicHuntersRuntime } from '../relic-hunters-runtime.ts';

interface RelicRoomMoveProps {
    readonly game: RelicHuntersRuntime.Connection;
}

export function RelicRoomMove({ game }: RelicRoomMoveProps) {
    const blockedReason = game.participation === 'spectator'
        ? 'Spectators stay. Join as player before proposing or confirming a move.'
        : hasUnfinishedRelicParticipation(game.snapshot, game.session?.sessionId)
        ? 'Finish or explicitly Leave expedition before confirming a move.'
        : null;
    return (
        <RoomMovePanel
            people={rallar.people}
            owner={game.roomMove}
            scope={RELIC_ROOM_SCOPE}
            session={game.session}
            roomId={game.roomId}
            rooms={game.rooms}
            destinations={game.directory.entries}
            connected={game.diagnostics.middlewareConnected}
            blockedReason={blockedReason}
        />
    );
}
