import type { RelicPublicSnapshot, RelicRoom } from '@relic-hunters/mod.ts';
import { describe, expect, it } from 'vitest';
import { sceneMoveActionForPickedRoom } from '../src/game/scene/movement.ts';

const rooms: readonly RelicRoom[] = [
    { id: 'entrance', name: 'Entrance', kind: 'entrance', x: 0, z: 0, neighbors: ['hallway', 'storage'] },
    { id: 'hallway', name: 'Hallway', kind: 'hallway', x: 0, z: 1, neighbors: ['entrance'] },
    { id: 'storage', name: 'Storage', kind: 'storage', x: -1, z: 1, neighbors: ['entrance'], collapsed: true },
    { id: 'shrine', name: 'Shrine', kind: 'shrine', x: 1, z: 1, neighbors: [] }
];

describe('scene movement', () => {
    it('creates a move action for a legal adjacent picked room', () => {
        expect(sceneMoveActionForPickedRoom({
            snapshot: snapshot(),
            localPlayerId: 'alice-session',
            roomId: 'hallway'
        })).toEqual({
            kind: 'move',
            targetRoomId: 'hallway'
        });
    });

    it('ignores the current room, collapsed rooms, and non-neighbors', () => {
        const shot = snapshot();

        expect(sceneMoveActionForPickedRoom({
            snapshot: shot,
            localPlayerId: 'alice-session',
            roomId: 'entrance'
        })).toBeUndefined();
        expect(sceneMoveActionForPickedRoom({
            snapshot: shot,
            localPlayerId: 'alice-session',
            roomId: 'storage'
        })).toBeUndefined();
        expect(sceneMoveActionForPickedRoom({
            snapshot: shot,
            localPlayerId: 'alice-session',
            roomId: 'shrine'
        })).toBeUndefined();
    });

    it('does not prime movement after the local plan has been locked', () => {
        expect(sceneMoveActionForPickedRoom({
            snapshot: snapshot({ submittedPlayerIds: ['alice-session'] }),
            localPlayerId: 'alice-session',
            roomId: 'hallway'
        })).toBeUndefined();
    });
});

function snapshot(
    options: Readonly<{ submittedPlayerIds?: readonly string[]; }> = {}
): RelicPublicSnapshot {
    return {
        protocolVersion: 1,
        gameId: 'room-1',
        roomId: 'room-1',
        phase: 'planning',
        round: 1,
        maxRounds: 10,
        updatedAtEpochMs: 1,
        roundTimeLimitMs: 60_000,
        map: rooms,
        relics: [],
        roomInvestigations: [],
        players: [
            {
                playerId: 'alice-session',
                username: 'Alice',
                characterId: 'kael-ironstride',
                roomId: 'entrance',
                health: 3,
                escaped: false,
                defeated: false,
                score: 0,
                relicIds: []
            }
        ],
        submittedPlayerIds: options.submittedPlayerIds ?? [],
        events: [],
        winnerIds: []
    };
}
