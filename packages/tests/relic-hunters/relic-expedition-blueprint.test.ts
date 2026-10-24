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
import {
    describe,
    expect,
    it
} from 'vitest';

import { requireRelicCommandApplied } from './require-relic-command-applied.ts';

describe('Relic expedition blueprints', () => {
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

        state = requireRelicCommandApplied(applyRelicCommand(state, join('Alice'), {
            senderId: 'alice',
            now: 2
        })).state;
        expect(state.players[0]).toMatchObject({
            playerId: 'alice',
            roomId: 'entrance'
        });

        state = requireRelicCommandApplied(applyRelicCommand(state, start('Alice'), {
            senderId: 'alice',
            now: 3
        })).state;
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
        {
            senderId: 'alice',
            now: now
        }
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
            {
                senderId: 'alice',
                now: now + 0.5
            }
        )).state
        : submitted;
}
