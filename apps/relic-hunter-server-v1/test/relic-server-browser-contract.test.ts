import {
    createRelicGame,
    isRelicHunterEvent,
    isRelicSnapshot,
    RELIC_PROTOCOL_VERSION,
    RELIC_TOPICS,
    RELIC_TYPES,
    type RelicCommand,
    type RelicGameState,
    type RelicServerEvent
} from '@relic-hunters/mod.ts';
import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { RallarServerWsPublishInputDto } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import { expect } from '@std/expect';
import { describe, it } from '@std/testing/bdd';
import { installRelicHunterGame } from '../src/relic-game-service.ts';

describe('Relic Hunter server browser contract', () => {
    it('publishes snapshots in the shape consumed by browser WebSocket subscribers', async () => {
        const fake = createFakeRallar();
        const service = await installRelicHunterGame(fake.rallar, {
            createInitialState: (gameId) => Promise.resolve(createRelicGame(gameId, gameId, 1)),
            readSession: (sessionId: string) => Promise.resolve(sessionId === 'alice-session' ? { username: 'Alice', clientId: 'alice-client' } : undefined)
        });

        await service.applyCommand(joinCommand(), { sessionId: 'alice-session', clientId: 'alice-client' });

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

    it('publishes a refused command\'s hunter event in the shape the browser\'s guard reads', async () => {
        const fake = createFakeRallar();
        const service = await installRelicHunterGame(fake.rallar, {
            createInitialState: (gameId) => Promise.resolve(createRelicGame(gameId, gameId, 1)),
            readSession: () => Promise.resolve(undefined)
        });

        await expect(service.applyCommand(pickupCommand(), ALICE_SENDER)).rejects.toThrow('The expedition has not started.');

        const message = fake.published.at(-1)!.message;
        expect(message.route.topicId).toBe(RELIC_TOPICS.hunter);
        expect(message.payload.typeId).toBe(RELIC_TYPES.hunter);
        expect(isRelicHunterEvent(decodeJsonWireValue(JSON.parse(message.payload.resource), 'Published Relic hunter event')))
            .toBe(true);
    });
});

function createFakeRallar(): Readonly<{
    rallar: Parameters<typeof installRelicHunterGame>[0];
    published: RallarServerWsPublishInputDto[];
}> {
    const store = new Map<string, RelicGameState>();
    const published: RallarServerWsPublishInputDto[] = [];

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
            serverPeerId: 'relic-server',
            defineTopic: () => {},
            on: () => {},
            publish: (publication: RallarServerWsPublishInputDto) => {
                published.push(publication);
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

const ALICE_SENDER = { sessionId: 'alice-session', clientId: 'alice-client' };

function pickupCommand(): RelicCommand {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'pickup-relic',
        gameId: 'room-1',
        username: 'Alice',
        relicId: 'no-such-relic'
    };
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
