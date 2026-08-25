import {
    createRelicGame,
    isRelicSnapshot,
    RELIC_PROTOCOL_VERSION,
    RELIC_TOPICS,
    RELIC_TYPES,
    type RelicCommand,
    type RelicGameState,
    type RelicServerEvent
} from '@relic-hunters/mod.ts';
import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { expect } from '@std/expect';
import { describe, it } from '@std/testing/bdd';
import { installRelicHunterGame } from '../src/relic-game-service.ts';

describe('Relic Hunter server browser contract', () => {
    it('publishes snapshots in the shape consumed by browser WebSocket subscribers', async () => {
        const fake = createFakeRallar();
        const service = await installRelicHunterGame(fake.rallar, {
            createInitialState: (gameId) => Promise.resolve(createRelicGame(gameId, gameId, 1))
        });

        await service.applyCommand(joinCommand(), 'alice-session');

        const message = fake.published[0].message;
        const browserPayload = decodeRelicServerEvent(message.payload.resource);

        expect(message.route.topicId).toBe(RELIC_TOPICS.snapshot);
        expect(message.route.contextId).toBe('room-1');
        expect(message.payload.typeId).toBe(RELIC_TYPES.snapshot);
        expect(browserPayload).toMatchObject({
            protocolVersion: RELIC_PROTOCOL_VERSION,
            gameId: 'room-1'
        });
        expect(isRelicSnapshot(browserPayload.snapshot)).toBe(true);
        expect(browserPayload.snapshot.roomInvestigations).toEqual([]);
        expect(browserPayload.snapshot.players[0]).toMatchObject({
            playerId: 'alice-session',
            username: 'Alice'
        });
    });
});

function createFakeRallar(): Readonly<{
    rallar: Parameters<typeof installRelicHunterGame>[0];
    published: Array<
        Readonly<{
            message: Readonly<{
                route: Readonly<{ topicId: string; contextId: string; }>;
                payload: Readonly<{ typeId: string; resource: string; }>;
            }>;
        }>
    >;
}> {
    const store = new Map<string, RelicGameState>();
    const published: Array<
        Readonly<{
            message: Readonly<{
                route: Readonly<{ topicId: string; contextId: string; }>;
                payload: Readonly<{ typeId: string; resource: string; }>;
            }>;
        }>
    > = [];

    const rallar = {
        appData: {
            open: () =>
                Promise.resolve({
                    get: (key: string) => Promise.resolve(store.get(key)),
                    set: (key: string, value: RelicGameState) => {
                        store.set(key, value);
                        return Promise.resolve();
                    },
                    setIfAbsent: (key: string, create: () => RelicGameState) => {
                        const existing = store.get(key);
                        if (existing) {
                            return Promise.resolve(existing);
                        }
                        const value = create();
                        store.set(key, value);
                        return Promise.resolve(value);
                    }
                })
        },
        ws: {
            defineTopic: () => {},
            on: () => {},
            publish: (
                message: {
                    route: { topicId: string; contextId: string; };
                    payload: { typeId: string; resource: string; };
                }
            ) => {
                published.push({ message });
                return Promise.resolve();
            }
        }
    };

    return { rallar, published };
}

function decodeRelicServerEvent(resource: string): RelicServerEvent {
    const value = decodeJsonWireValue(
        JSON.parse(resource),
        'Published Relic server event'
    );
    if (
        !isJsonWireObject(value) ||
        value.protocolVersion !== RELIC_PROTOCOL_VERSION ||
        typeof value.gameId !== 'string' ||
        !isRelicSnapshot(value.snapshot)
    ) {
        throw new TypeError('Published Relic server event is malformed.');
    }
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        gameId: value.gameId,
        snapshot: value.snapshot
    };
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function joinCommand(): RelicCommand {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'join-expedition',
        gameId: 'room-1',
        username: 'Alice',
        characterId: 'kael-ironstride'
    };
}
