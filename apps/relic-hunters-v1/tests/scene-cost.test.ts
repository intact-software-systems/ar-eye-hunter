import { describe, expect, it } from 'vitest';
import type { RelicPublicSnapshot, RelicRoom } from '@relic-hunters/mod.ts';
import { selectActiveEffectRoomIds } from '../src/game/scene/sceneCost.ts';

const rooms: readonly RelicRoom[] = [
    { id: 'entrance', name: 'Entrance', kind: 'entrance', x: 0, z: -6, neighbors: ['hallway', 'storage'] },
    { id: 'hallway', name: 'Hallway', kind: 'hallway', x: 0, z: -3, neighbors: ['entrance', 'shrine', 'monster'] },
    { id: 'storage', name: 'Storage', kind: 'storage', x: -4, z: -3, neighbors: ['entrance', 'trap'] },
    { id: 'trap', name: 'Trap Room', kind: 'trap', x: -4, z: 0, neighbors: ['storage', 'shrine'] },
    { id: 'shrine', name: 'Shrine', kind: 'shrine', x: 0, z: 0, neighbors: ['hallway', 'trap', 'treasure', 'exit'] },
    { id: 'monster', name: 'Monster', kind: 'monster', x: 4, z: -3, neighbors: ['hallway', 'treasure'] },
    { id: 'treasure', name: 'Treasure', kind: 'treasure', x: 4, z: 0, neighbors: ['monster', 'shrine'] },
    { id: 'exit', name: 'Exit', kind: 'exit', x: 0, z: 3, neighbors: ['shrine'] },
];

describe('scene cost active room selection', () => {
    it('does not activate gameplay room effects for lobby or missing snapshots', () => {
        expect(selectActiveEffectRoomIds({
            snapshot: undefined,
            localPlayerId: 'alice-session',
        })).toEqual([]);
        expect(selectActiveEffectRoomIds({
            snapshot: snapshot('lobby'),
            localPlayerId: 'alice-session',
        })).toEqual([]);
    });

    it('prioritizes current room, selected room, objective, party rooms, and nearby graph', () => {
        expect(selectActiveEffectRoomIds({
            snapshot: snapshot('planning', {
                playerRooms: {
                    'alice-session': 'entrance',
                    'bob-session': 'shrine',
                    'cara-session': 'monster',
                    'dain-session': 'exit',
                },
            }),
            localPlayerId: 'alice-session',
            selectedRoomId: 'treasure',
            objectiveTargetRoomId: 'shrine',
            maxRooms: 6,
        })).toEqual([
            'entrance',
            'treasure',
            'shrine',
            'monster',
            'exit',
            'hallway',
        ]);
    });

    it('caps active effect rooms on large maps while preserving high-priority targets', () => {
        const active = selectActiveEffectRoomIds({
            snapshot: snapshot('planning', {
                playerRooms: {
                    'alice-session': 'storage',
                    'bob-session': 'exit',
                },
            }),
            localPlayerId: 'alice-session',
            selectedRoomId: 'treasure',
            objectiveTargetRoomId: 'exit',
            maxRooms: 4,
        });

        expect(active).toHaveLength(4);
        expect(active).toContain('storage');
        expect(active).toContain('treasure');
        expect(active).toContain('exit');
    });
});

function snapshot(
    phase: RelicPublicSnapshot['phase'],
    options: Readonly<{ playerRooms?: Readonly<Record<string, string>> }> = {},
): RelicPublicSnapshot {
    return {
        protocolVersion: 1,
        gameId: 'room-1',
        roomId: 'room-1',
        phase,
        round: 1,
        maxRounds: 10,
        updatedAtEpochMs: Date.now(),
        map: rooms,
        relics: [],
        roomInvestigations: [],
        players: [
            player('alice-session', options.playerRooms?.['alice-session'] ?? 'entrance'),
            player('bob-session', options.playerRooms?.['bob-session'] ?? 'hallway'),
            player('cara-session', options.playerRooms?.['cara-session'] ?? 'storage'),
            player('dain-session', options.playerRooms?.['dain-session'] ?? 'trap'),
        ],
        submittedPlayerIds: [],
        events: [],
        winnerIds: [],
    };
}

function player(playerId: string, roomId: string): RelicPublicSnapshot['players'][number] {
    return {
        playerId,
        username: playerId,
        characterId: 'kael-ironstride',
        roomId,
        health: 3,
        escaped: false,
        defeated: false,
        score: 0,
        relicIds: [],
    };
}
