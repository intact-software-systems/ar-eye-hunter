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
import { describe, expect, it } from 'vitest';

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
            'room-1',
            'room-1',
            testBlueprint(),
            1,
            {
                source: 'mock',
                seed: 'test-seed',
                blueprintId: 'test-blueprint'
            }
        );

        expect(state.setup).toMatchObject({
            source: 'mock',
            seed: 'test-seed',
            blueprintId: 'test-blueprint'
        });

        state = applyRelicCommand(state, join('alice', 'Alice'), {
            senderId: 'alice',
            now: () => 2
        }).state;
        expect(state.players[0]).toMatchObject({
            playerId: 'alice',
            roomId: 'entrance'
        });

        state = applyRelicCommand(state, start('alice', 'Alice'), {
            senderId: 'alice',
            now: () => 3
        }).state;
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
        const publicSetup: Readonly<Record<string, unknown>> = {
            ...toPublicRelicSnapshot(state).setup
        };
        expect(publicSetup.seed).toBeUndefined();
        expect(publicSetup.blueprintId).toBeUndefined();
    });
});

function testBlueprint(): RelicExpeditionBlueprint {
    return {
        schemaVersion: 1,
        seed: 'test-seed',
        theme: 'Test Keep',
        source: 'mock',
        rooms: [
            room('entrance', 'Test Gate', 'entrance', 0, -6, ['hallway']),
            room('hallway', 'Test Hall', 'hallway', 0, -3, ['entrance', 'storage', 'trap', 'treasure']),
            room('storage', 'Test Stores', 'storage', -4, -3, ['hallway']),
            room('trap', 'Test Trap', 'trap', -2, 0, ['hallway']),
            room('treasure', 'Test Vault', 'treasure', 2, 0, ['hallway', 'exit']),
            room('monster', 'Test Barracks', 'monster', 0, 3, ['exit']),
            room('exit', 'Test Exit', 'exit', 0, 6, ['treasure', 'monster'])
        ],
        relics: [
            { id: 'ruby-seal', name: 'Ruby Seal', value: 9, roomId: 'treasure' },
            { id: 'silver-comb', name: 'Silver Comb', value: 3, roomId: 'storage' },
            { id: 'storm-bell', name: 'Storm Bell', value: 4, roomId: 'trap' },
            { id: 'ash-mask', name: 'Ash Mask', value: 5, roomId: 'monster' }
        ]
    };
}

function room(
    id: RelicExpeditionBlueprint['rooms'][number]['id'],
    name: string,
    kind: RelicExpeditionBlueprint['rooms'][number]['kind'],
    x: number,
    z: number,
    neighbors: readonly string[]
): RelicExpeditionBlueprint['rooms'][number] {
    return { id, name, kind, x, z, neighbors };
}

function join(playerId: string, username: string): RelicCommand {
    void playerId;
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'join-expedition',
        gameId: 'room-1',
        username
    };
}

function start(playerId: string, username: string): RelicCommand {
    void playerId;
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
    const submitted = applyRelicCommand(
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
            now: () => now
        }
    ).state;

    return submitted.phase === 'review'
        ? applyRelicCommand(
            submitted,
            {
                protocolVersion: RELIC_PROTOCOL_VERSION,
                kind: 'continue-review',
                gameId: 'room-1',
                username: 'Alice'
            },
            {
                senderId: 'alice',
                now: () => now + 0.5
            }
        ).state
        : submitted;
}
