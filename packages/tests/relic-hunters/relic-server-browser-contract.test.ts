// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import {
    RELIC_PROTOCOL_VERSION,
    RELIC_TOPICS,
    RELIC_TYPES,
    isRelicSnapshot,
    type RelicCommand,
    type RelicGameState,
    type RelicServerEvent,
} from '@relic-hunters/mod.ts';
import { installRelicHunterGame } from '../../../apps/relic-hunter-server-v1/src/relic-game-service.ts';

describe('Relic Hunter server browser contract', () => {
    it('publishes snapshots in the shape consumed by browser WebSocket subscribers', async () => {
        const fake = createFakeRallar();
        const service = await installRelicHunterGame(fake.rallar);

        await service.applyCommand(joinCommand(), 'alice-session');

        const message = fake.published[0].message;
        const browserPayload = JSON.parse(message.payload.resource) as RelicServerEvent;

        expect(message.route.topicId).toBe(RELIC_TOPICS.snapshot);
        expect(message.route.contextId).toBe('room-1');
        expect(message.payload.typeId).toBe(RELIC_TYPES.snapshot);
        expect(browserPayload).toMatchObject({
            protocolVersion: RELIC_PROTOCOL_VERSION,
            gameId: 'room-1',
        });
        expect(isRelicSnapshot(browserPayload.snapshot)).toBe(true);
        expect(browserPayload.snapshot.players[0]).toMatchObject({
            playerId: 'alice-session',
            username: 'Alice',
        });
    });
});

function createFakeRallar(): Readonly<{
    rallar: Parameters<typeof installRelicHunterGame>[0];
    published: Array<Readonly<{
        message: Readonly<{
            route: Readonly<{ topicId: string; contextId: string }>;
            payload: Readonly<{ typeId: string; resource: string }>;
        }>;
    }>>;
}> {
    const store = new Map<string, RelicGameState>();
    const published: Array<Readonly<{
        message: Readonly<{
            route: Readonly<{ topicId: string; contextId: string }>;
            payload: Readonly<{ typeId: string; resource: string }>;
        }>;
    }>> = [];

    const rallar = {
        data: {
            open: vi.fn(async () => ({
                get: async (key: string) => store.get(key),
                set: async (key: string, value: RelicGameState) => {
                    store.set(key, value);
                },
                setIfAbsent: async (key: string, create: () => RelicGameState) => {
                    const existing = store.get(key);
                    if (existing) {
                        return existing;
                    }
                    const value = create();
                    store.set(key, value);
                    return value;
                },
            })),
        },
        ws: {
            defineTopic: vi.fn(),
            on: vi.fn(),
            publish: vi.fn(async (message: { route: { topicId: string; contextId: string }; payload: { typeId: string; resource: string } }) => {
                published.push({ message });
            }),
        },
    } as unknown as Parameters<typeof installRelicHunterGame>[0];

    return { rallar, published };
}

function joinCommand(): RelicCommand {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'join-expedition',
        gameId: 'room-1',
        username: 'Alice',
        characterId: 'kael-ironstride',
    };
}
