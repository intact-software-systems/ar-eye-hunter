import {
    applyRelicCommand,
    createProceduralRelicExpeditionBlueprint,
    createRelicGameFromBlueprint,
    RELIC_EXPEDITION_VISUAL_THEMES,
    RELIC_PROTOCOL_VERSION,
    toPublicRelicSnapshot,
    validateRelicExpeditionBlueprint,
    validateRelicExpeditionVisualFit,
    type RelicCommand,
    type RelicExpeditionBlueprint,
    type RelicGameState
} from '@relic-hunters/mod.ts';
import type { RallarAiValidationIssue } from '@shared/rallar-ai/mod.ts';
import {
    describe,
    expect,
    it
} from 'vitest';

import { requireRelicCommandApplied } from './require-relic-command-applied.ts';

describe('Relic expedition blueprints', () => {
    it('gives one theme and one relic set per string seed', () => {
        const blueprint = createProceduralRelicExpeditionBlueprint({ seed: 'room-1:reset:1' });

        expect(blueprint.theme).toBe('Breeze Watchtower');
        expect(blueprint.rooms.map((room) => `${room.id}@${room.x},${room.z}`)).toEqual([
            'entrance@0,-5',
            'hallway@0,-2',
            'storage@-4,-2',
            'shrine@4,-2',
            'trap@0,1',
            'treasure@4,1',
            'monster@0,4',
            'exit@0,7',
            'gallery@2,0'
        ]);
        expect(blueprint.relics.map((relic) => `${relic.name}:${relic.value}:${relic.roomId}`)).toEqual([
            'Bronze Mirror That Blames You:5:entrance',
            'Lotus Crown of Unpaid Overtime:10:hallway',
            'Golden Koi Exit Voucher:6:storage',
            'Neon Shrine Receipt:2:shrine',
            'Moon Comb for Executive Hair:11:trap',
            'Predator Wellness Coupon:4:treasure',
            'Storm Pearl Helpdesk Ticket:5:monster',
            'Ivory Netsuke of Mild Panic:2:exit',
            'Silver Bell of Mandatory Cheer:2:gallery',
            'Jade Oni Severance Seal:4:entrance',
            'Gift Shop Escape Stub:4:hallway',
            'Ashen Tanto Return Form:2:storage',
            'Crimson Fan of Quarterly Losses:6:shrine'
        ]);
    });

    it('accepts procedural blueprints and rejects invalid domain shapes', () => {
        const valid = createProceduralRelicExpeditionBlueprint({
            seed: 'room-1:reset:1'
        });

        expect(validateRelicExpeditionBlueprint(valid)).toMatchObject({ ok: true });
        expect(validateRelicExpeditionBlueprint({
            ...valid,
            rooms: valid.rooms.map((room) => room.id === 'exit' ? { ...room, neighbors: [] } : room)
        })).toMatchObject({ ok: false });
        expect(validateRelicExpeditionBlueprint({
            ...valid,
            rooms: valid.rooms.filter((room) => room.id !== 'entrance')
        })).toMatchObject({ ok: false });
        expect(validateRelicExpeditionBlueprint({
            ...valid,
            rooms: [
                ...valid.rooms,
                { ...valid.rooms[0], id: 'duplicate-gate' }
            ]
        })).toMatchObject({ ok: false });
        expect(validateRelicExpeditionBlueprint({
            ...valid,
            relics: valid.relics.map((relic, index) => index === 0 ? { ...relic, roomId: 'missing-room' } : relic)
        })).toMatchObject({ ok: false });
    });

    it('validates fresh visual-fit constraints for AI-generated castles', () => {
        const valid = createProceduralRelicExpeditionBlueprint({
            seed: 'room-1:reset:2'
        });

        expect(RELIC_EXPEDITION_VISUAL_THEMES).toContain(valid.theme);
        expect(validateRelicExpeditionVisualFit(valid)).toMatchObject({ ok: true });
        expect(validateRelicExpeditionVisualFit({
            ...valid,
            theme: 'Moonlit Keep'
        })).toMatchObject({ ok: false });
        expect(validateRelicExpeditionVisualFit({
            ...valid,
            rooms: valid.rooms.map((room) => room.id === 'entrance' ? { ...room, x: 0.5 } : room)
        })).toMatchObject({ ok: false });
        expect(validateRelicExpeditionVisualFit({
            ...valid,
            rooms: valid.rooms.map((room) => room.id === 'storage' ? { ...room, x: -8 } : room)
        })).toMatchObject({ ok: false });
        expect(validateRelicExpeditionVisualFit({
            ...valid,
            rooms: valid.rooms.map((room) =>
                room.id === 'entrance'
                    ? { ...room, name: 'A Fresh Room Name That Is Far Too Long For Compact HUD Labels' }
                    : room
            )
        })).toMatchObject({ ok: false });
        expect(validateRelicExpeditionVisualFit({
            ...valid,
            rooms: valid.rooms.map((room) => room.id === 'exit' ? { ...room, x: 6, z: 7 } : room)
        })).toMatchObject({ ok: false });
    });

    it('reports every issue of a value that is not an object, or whose rooms and relics are not lists', () => {
        const valid = createProceduralRelicExpeditionBlueprint({ seed: 'room-1:reset:1' });
        const notObject = [issue('$', 'type-mismatch', 'Expected object.')];
        const notLists = [
            issue('$.rooms', 'type-mismatch', 'Expected array.'),
            issue('$.relics', 'type-mismatch', 'Expected array.'),
            issue('$.rooms', 'missing-entrance', 'Blueprint must include room id entrance.'),
            issue('$.rooms', 'missing-exit', 'Blueprint must include room id exit.')
        ];

        expect(validationIssues(null)).toEqual({ blueprint: notObject, visualFit: notObject });
        expect(validationIssues({ ...valid, rooms: 'none', relics: 'none' })).toEqual({
            blueprint: notLists,
            visualFit: notLists
        });
    });

    it('reports malformed rooms by their position among the object rooms, and graph faults by room id', () => {
        const valid = createProceduralRelicExpeditionBlueprint({ seed: 'room-1:reset:1' });
        const malformed = {
            ...valid,
            rooms: [
                7,
                ...valid.rooms.map((room) => {
                    switch (room.id) {
                        case 'entrance':
                            return { ...room, kind: 'hallway' };
                        case 'hallway':
                            return { ...room, neighbors: [...room.neighbors, 'hallway', 'entrance'] };
                        case 'storage':
                            return { ...room, collapsed: true };
                        case 'shrine':
                            return { ...room, x: 0, z: room.z + 3 };
                        case 'trap':
                            return { ...room, neighbors: [...room.neighbors, 'ghost'] };
                        case 'exit':
                            return { ...room, neighbors: [] };
                        default:
                            return room;
                    }
                }),
                { ...valid.rooms[1], id: 'Bad Id' },
                { ...valid.rooms[1], id: 'storage', x: 9, z: 9 }
            ]
        };
        const blueprint = [
            issue('$.rooms[0]', 'type-mismatch', 'Expected object.'),
            issue('$.rooms[3].collapsed', 'additional-property', 'Additional property is not allowed.'),
            issue('$.rooms[8].neighbors', 'min-items', 'Expected array length >= 1.'),
            issue('$.rooms[1].neighbors[4]', 'self-neighbor', 'Room cannot neighbor itself.'),
            issue('$.rooms[1].neighbors[5]', 'duplicate-neighbor', 'Neighbor id must be unique per room.'),
            issue('$.rooms[2]', 'initial-room-state', 'Rooms cannot start collapsed or unstable.'),
            issue('$.rooms[4]', 'overlapping-room-coordinate', 'Room coordinates must not overlap.'),
            issue('$.rooms[9].id', 'invalid-room-id', 'Room id must be stable kebab-case.'),
            issue('$.rooms[10].id', 'duplicate-room-id', 'Room id must be unique.'),
            issue('$.rooms.entrance.kind', 'invalid-entrance-kind', 'Entrance room must use entrance kind.'),
            issue('$.rooms.trap.neighbors', 'unknown-neighbor', 'Unknown neighbor ghost.'),
            issue('$.rooms.monster.neighbors', 'asymmetric-neighbor', 'Neighbor exit must link back to monster.'),
            issue('$.rooms.Bad Id.neighbors', 'asymmetric-neighbor', 'Neighbor entrance must link back to Bad Id.'),
            issue('$.rooms.Bad Id.neighbors', 'asymmetric-neighbor', 'Neighbor shrine must link back to Bad Id.'),
            issue('$.rooms.Bad Id.neighbors', 'asymmetric-neighbor', 'Neighbor trap must link back to Bad Id.'),
            issue('$.rooms.Bad Id.neighbors', 'asymmetric-neighbor', 'Neighbor gallery must link back to Bad Id.'),
            issue('$.rooms.storage.neighbors', 'asymmetric-neighbor', 'Neighbor shrine must link back to storage.'),
            issue('$.rooms.storage.neighbors', 'asymmetric-neighbor', 'Neighbor gallery must link back to storage.'),
            issue('$.rooms', 'disconnected-graph', 'Every room must be reachable from entrance.')
        ];

        expect(validationIssues(malformed)).toEqual({
            blueprint,
            visualFit: [
                ...blueprint,
                issue('$.rooms[0].neighbors', 'visual-edge-distance', EDGE_DISTANCE_MESSAGE),
                issue('$.rooms[10].x', 'visual-coordinate-footprint', 'Room coordinate must stay within +/-6.'),
                issue('$.rooms[10].z', 'visual-coordinate-footprint', 'Room coordinate must stay within +/-7.'),
                issue('$.rooms[10].neighbors', 'visual-edge-distance', EDGE_DISTANCE_MESSAGE)
            ]
        });
    });

    it('reports a missing exit, an unreachable exit and rooms the entrance cannot reach', () => {
        const valid = createProceduralRelicExpeditionBlueprint({ seed: 'room-1:reset:1' });
        const withoutExit = [
            issue('$.rooms.entrance.kind', 'invalid-entrance-kind', 'Entrance room must use entrance kind.'),
            issue('$.rooms', 'missing-exit', 'Blueprint must include room id exit.'),
            issue('$.rooms.storage.neighbors', 'asymmetric-neighbor', 'Neighbor entrance must link back to storage.'),
            issue('$.rooms.monster.neighbors', 'unknown-neighbor', 'Unknown neighbor exit.'),
            issue('$.relics[7].roomId', 'unknown-relic-room', 'Relic roomId must refer to a room in the blueprint.')
        ];
        const islandExit = [
            issue('$.rooms[7].unstable', 'additional-property', 'Additional property is not allowed.'),
            issue('$.rooms[7]', 'initial-room-state', 'Rooms cannot start collapsed or unstable.'),
            issue('$.rooms.exit.kind', 'invalid-exit-kind', 'Exit room must use exit kind.'),
            issue('$.rooms', 'unreachable-exit', 'Exit must be reachable from entrance.'),
            issue('$.rooms', 'disconnected-graph', 'Every room must be reachable from entrance.')
        ];

        expect(validationIssues({
            ...valid,
            rooms: valid.rooms
                .filter((room) => room.id !== 'exit')
                .map((room) => room.id === 'entrance' ? { ...room, kind: 'exit', neighbors: ['hallway'] } : room)
        })).toEqual({ blueprint: withoutExit, visualFit: withoutExit });
        expect(validationIssues({
            ...valid,
            rooms: valid.rooms.map((room) => {
                switch (room.id) {
                    case 'trap':
                        return { ...room, neighbors: room.neighbors.filter((id) => id !== 'monster') };
                    case 'monster':
                        return { ...room, neighbors: room.neighbors.filter((id) => id !== 'trap') };
                    case 'exit':
                        return { ...room, kind: 'monster', unstable: false };
                    default:
                        return room;
                }
            })
        })).toEqual({ blueprint: islandExit, visualFit: islandExit });
    });

    it('reports malformed relics by their list position', () => {
        const valid = createProceduralRelicExpeditionBlueprint({ seed: 'room-1:reset:1' });
        const relics = [
            issue('$.relics[0]', 'type-mismatch', 'Expected object.'),
            issue('$.relics[1].id', 'invalid-relic-id', 'Relic id must be stable kebab-case.'),
            issue('$.relics[3].id', 'duplicate-relic-id', 'Relic id must be unique.'),
            issue('$.relics[3].roomId', 'unknown-relic-room', 'Relic roomId must refer to a room in the blueprint.')
        ];

        expect(validationIssues({
            ...valid,
            relics: [
                'relic',
                { ...valid.relics[0], id: 'Bad Relic' },
                valid.relics[1],
                { ...valid.relics[1], roomId: 'vault' },
                ...valid.relics.slice(2)
            ]
        })).toEqual({ blueprint: relics, visualFit: relics });
    });

    it('reports visual misfits only to the visual fit, after any blueprint issue', () => {
        const valid = createProceduralRelicExpeditionBlueprint({ seed: 'room-1:reset:1' });
        const themeIssue = issue('$.theme', 'visual-theme', `Theme must be one of: ${RELIC_EXPEDITION_VISUAL_THEMES.join(', ')}.`);

        expect(validationIssues({
            ...valid,
            theme: 'Moonlit Keep',
            rooms: valid.rooms.map((room) => {
                switch (room.id) {
                    case 'entrance':
                        return { ...room, x: 0.5, name: 'A Fresh Room Name That Is Far Too Long For Compact HUD Labels' };
                    case 'storage':
                        return { ...room, x: -8 };
                    case 'exit':
                        return { ...room, x: 6, z: 7 };
                    default:
                        return room;
                }
            })
        })).toEqual({
            blueprint: [],
            visualFit: [
                themeIssue,
                issue('$.rooms[0].name', 'visual-room-name-length', 'Room names must fit compact HUD labels (42 chars max).'),
                issue('$.rooms[0].x', 'visual-coordinate-integer', 'Room coordinates must be integers.'),
                issue('$.rooms[0].neighbors', 'visual-edge-distance', EDGE_DISTANCE_MESSAGE),
                issue('$.rooms[2].x', 'visual-coordinate-footprint', 'Room coordinate must stay within +/-6.'),
                issue('$.rooms[2].neighbors', 'visual-edge-distance', EDGE_DISTANCE_MESSAGE),
                issue('$.rooms[7].neighbors', 'visual-edge-distance', EDGE_DISTANCE_MESSAGE)
            ]
        });
        expect(validationIssues({ ...valid, theme: 3 })).toEqual({
            blueprint: [issue('$.theme', 'type-mismatch', 'Expected string.')],
            visualFit: [issue('$.theme', 'type-mismatch', 'Expected string.'), themeIssue]
        });
    });

    it('creates playable game state from a validated blueprint', () => {
        let state = createRelicGameFromBlueprint(
            {
                gameId: 'room-1',
                roomId: 'room-1',
                blueprint: testBlueprint(),
                now: 1,
                setup: {
                    source: 'mock',
                    seed: 'test-seed',
                    blueprintId: 'test-blueprint'
                }
            }
        ).fold(
            (refusal) => {
                throw new Error(`Expected a valid fixture blueprint: ${refusal.message}`);
            },
            (state) => state
        );

        expect(state.setup).toMatchObject({
            source: 'mock',
            seed: 'test-seed',
            blueprintId: 'test-blueprint'
        });

        state = requireRelicCommandApplied(applyRelicCommand(state, join('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 2 })).state;
        expect(state.players[0]).toMatchObject({
            playerId: 'alice',
            roomId: 'entrance'
        });

        state = requireRelicCommandApplied(applyRelicCommand(state, start('Alice'), { presentPlayerIds: ['alice'], senderId: 'alice', now: 3 })).state;
        state = submitAndContinue(state, { kind: 'move', targetRoomId: 'hallway' }, 4);
        state = submitAndContinue(state, { kind: 'move', targetRoomId: 'treasure' }, 5);
        state = submitAndContinue(state, { kind: 'search' }, 6);
        state = submitAndContinue(state, { kind: 'move', targetRoomId: 'exit' }, 7);
        state = submitAndContinue(state, { kind: 'escape' }, 8);

        expect(state.phase).toBe('finished');
        expect(state.players[0]).toMatchObject({
            escaped: true,
            score: 14,
            relicIds: []
        });
        expect(state.relics.find((relic) => relic.id === 'ruby-seal')).toMatchObject({
            foundBy: 'alice',
            escapedBy: 'alice'
        });
        expect(toPublicRelicSnapshot(state).setup).toMatchObject({
            source: 'mock'
        });

        expect(toPublicRelicSnapshot(state).setup).not.toHaveProperty('seed');
        expect(toPublicRelicSnapshot(state).setup).not.toHaveProperty('blueprintId');
    });
});

const EDGE_DISTANCE_MESSAGE = 'Neighbor edges must stay within 5 grid units for camera and map readability.';

function validationIssues(value: object | null): {
    blueprint: readonly RallarAiValidationIssue[];
    visualFit: readonly RallarAiValidationIssue[];
} {
    return {
        blueprint: validateRelicExpeditionBlueprint(value).issues,
        visualFit: validateRelicExpeditionVisualFit(value).issues
    };
}

function issue(path: string, code: string, message: string): RallarAiValidationIssue {
    return { path, code, message };
}

function testBlueprint(): RelicExpeditionBlueprint {
    return {
        schemaVersion: 1,
        seed: 'test-seed',
        theme: 'Test Keep',
        source: 'mock',
        rooms: [
            { id: 'entrance', name: 'Test Gate', kind: 'entrance', x: 0, z: -6, neighbors: ['hallway'] },
            { id: 'hallway', name: 'Test Hall', kind: 'hallway', x: 0, z: -3, neighbors: ['entrance', 'storage', 'trap', 'treasure'] },
            { id: 'storage', name: 'Test Stores', kind: 'storage', x: -4, z: -3, neighbors: ['hallway'] },
            { id: 'trap', name: 'Test Trap', kind: 'trap', x: -2, z: 0, neighbors: ['hallway'] },
            { id: 'treasure', name: 'Test Vault', kind: 'treasure', x: 2, z: 0, neighbors: ['hallway', 'exit'] },
            { id: 'monster', name: 'Test Barracks', kind: 'monster', x: 0, z: 3, neighbors: ['exit'] },
            { id: 'exit', name: 'Test Exit', kind: 'exit', x: 0, z: 6, neighbors: ['treasure', 'monster'] }
        ],
        relics: [
            { id: 'ruby-seal', name: 'Ruby Seal', value: 9, roomId: 'treasure' },
            { id: 'silver-comb', name: 'Silver Comb', value: 3, roomId: 'storage' },
            { id: 'storm-bell', name: 'Storm Bell', value: 4, roomId: 'trap' },
            { id: 'ash-mask', name: 'Ash Mask', value: 5, roomId: 'monster' }
        ]
    };
}

function join(username: string): RelicCommand {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'join-expedition',
        gameId: 'room-1',
        username
    };
}

function start(username: string): RelicCommand {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'start-expedition',
        gameId: 'room-1',
        username
    };
}

function submitAndContinue(
    state: RelicGameState,
    action: Extract<RelicCommand, { kind: 'submit-action'; }>['action'],
    now: number
): RelicGameState {
    const submitted = requireRelicCommandApplied(applyRelicCommand(
        state,
        {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            kind: 'submit-action',
            gameId: 'room-1',
            username: 'Alice',
            action
        },
        { presentPlayerIds: ['alice'], senderId: 'alice', now: now }
    )).state;

    return submitted.phase === 'review'
        ? requireRelicCommandApplied(applyRelicCommand(
            submitted,
            {
                protocolVersion: RELIC_PROTOCOL_VERSION,
                kind: 'continue-review',
                gameId: 'room-1',
                username: 'Alice'
            },
            { presentPlayerIds: ['alice'], senderId: 'alice', now: now + 0.5 }
        )).state
        : submitted;
}
