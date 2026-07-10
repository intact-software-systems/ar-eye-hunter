import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    RELIC_PROTOCOL_VERSION,
    RELIC_TOPICS,
    RELIC_TYPES,
    createRelicGame,
    type RelicCommand,
    type RelicGameState,
} from '@relic-hunters/mod.ts';
import { installRelicHunterGame } from '../../../apps/relic-hunter-server-v1/src/relic-game-service.ts';

type TopicDefinition = Readonly<{
    topicId: string;
    typeId: string;
    validate(value: unknown, context: Readonly<{ roomId?: string }>): boolean;
}>;

type PublishedMessage = Readonly<{
    message: Readonly<{
        route: Readonly<{ topicId: string; contextId: string; resourceId: string }>;
        payload: Readonly<{ typeId: string; resource: string }>;
        targets?: Readonly<{ mode: string; scope?: string }>;
        delivery?: Readonly<{ reliability?: string }>;
    }>;
    fanout: string;
}>;

describe('Relic Hunter server game service', () => {
    beforeEach(() => {
        vi.useRealTimers();
    });

    it('registers a room-scoped command topic that rejects commands for other rooms', async () => {
        const fake = createFakeRallar();
        await installRelicHunterGame(fake.rallar);

        expect(fake.topicDefinition).toMatchObject({
            topicId: RELIC_TOPICS.command,
            typeId: RELIC_TYPES.command,
            scope: 'room',
            fanout: 'none',
            maxPayloadBytes: 16 * 1024,
        });
        expect(fake.topicDefinition?.validate(joinCommand('room-1'), { roomId: 'room-1' }))
            .toBe(true);
        expect(fake.topicDefinition?.validate(joinCommand('room-1'), { roomId: 'room-2' }))
            .toBe(false);
        expect(fake.topicDefinition?.validate({ kind: 'join-expedition' }, { roomId: 'room-1' }))
            .toBe(false);
    });

    it('persists command results and publishes live snapshots', async () => {
        const fake = createFakeRallar();
        const service = await installRelicHunterGame(fake.rallar);

        const snapshot = await service.applyCommand(joinCommand('room-1'), 'alice-session');

        expect(snapshot.players).toHaveLength(1);
        expect(snapshot.players[0]).toMatchObject({
            playerId: 'alice-session',
            username: 'Alice',
            characterId: 'nyra-vale',
        });
        expect(fake.store.get('room-1')?.players).toHaveLength(1);
        expect(fake.published).toHaveLength(1);
        expect(fake.published[0]).toMatchObject({
            fanout: 'live-only',
            message: {
                route: {
                    topicId: RELIC_TOPICS.snapshot,
                    contextId: 'room-1',
                    resourceId: 'room-1:1',
                },
                payload: {
                    typeId: RELIC_TYPES.snapshot,
                },
                targets: {
                    mode: 'broadcast',
                    scope: 'room',
                },
                delivery: {
                    reliability: 'at-least-once',
                },
            },
        });

        const publishedEvent = JSON.parse(fake.published[0].message.payload.resource);
        expect(publishedEvent.snapshot.players[0].playerId).toBe('alice-session');
    });

    it('keeps game state isolated per room', async () => {
        const fake = createFakeRallar();
        const service = await installRelicHunterGame(fake.rallar);

        await service.applyCommand(joinCommand('room-1'), 'alice-session');
        await service.applyCommand({
            ...joinCommand('room-2'),
            username: 'Bob',
            characterId: 'kael-ironstride',
        }, 'bob-session');

        await expect(service.readSnapshot('room-1')).resolves.toMatchObject({
            gameId: 'room-1',
            roomId: 'room-1',
            players: [{ playerId: 'alice-session' }],
        });
        await expect(service.readSnapshot('room-2')).resolves.toMatchObject({
            gameId: 'room-2',
            roomId: 'room-2',
            players: [{ playerId: 'bob-session' }],
        });
        expect(fake.store.get('room-1')?.players).toHaveLength(1);
        expect(fake.store.get('room-2')?.players).toHaveLength(1);
    });

    it('resets persisted room state and publishes the empty lobby snapshot', async () => {
        const fake = createFakeRallar();
        const service = await installRelicHunterGame(fake.rallar);

        await service.applyCommand(joinCommand('room-1'), 'alice-session');
        const reset = await service.reset('room-1');

        expect(reset).toMatchObject({
            gameId: 'room-1',
            phase: 'lobby',
            players: [],
            submittedPlayerIds: [],
        });
        expect(fake.store.get('room-1')?.players).toEqual([]);
        expect(fake.published).toHaveLength(2);
        const resetEvent = JSON.parse(fake.published[1].message.payload.resource);
        expect(resetEvent.snapshot).toMatchObject({
            gameId: 'room-1',
            phase: 'lobby',
            players: [],
        });
    });

    it('handles WebSocket commands through the registered command handler', async () => {
        const fake = createFakeRallar();
        await installRelicHunterGame(fake.rallar);

        await fake.commandHandler?.(
            { payload: joinCommand('room-1') },
            { senderId: 'alice-session' },
        );

        expect(fake.store.get('room-1')?.players[0]?.playerId).toBe('alice-session');
        expect(fake.published).toHaveLength(1);
    });

    it('uses the centralized async initializer for ensure, reset, and missing command state', async () => {
        const fake = createFakeRallar();
        const calls: string[] = [];
        const service = await installRelicHunterGame(fake.rallar, {
            createInitialState: async (gameId, reason) => {
                calls.push(`${reason}:${gameId}`);
                return {
                    ...createRelicGame(gameId, gameId, 100 + calls.length),
                    setup: {
                        schemaVersion: 1,
                        source: 'procedural',
                        seed: `${reason}-${calls.length}`,
                        blueprintId: `${reason}-blueprint`,
                    },
                };
            },
        });

        const ensured = await service.ensureSnapshot('room-1');
        expect(ensured.setup).toMatchObject({
            source: 'procedural',
        });
        expect(ensured.setup?.seed).toBeUndefined();

        const joined = await service.applyCommand(joinCommand('room-2'), 'alice-session');
        expect(joined.setup).toMatchObject({
            source: 'procedural',
        });
        expect(joined.setup?.seed).toBeUndefined();

        const reset = await service.reset('room-1');
        expect(reset.setup).toMatchObject({
            source: 'procedural',
        });
        expect(reset.setup?.seed).toBeUndefined();
        expect(calls).toEqual([
            'ensure:room-1',
            'command:room-2',
            'reset:room-1',
        ]);
    });
});

function createFakeRallar(): Readonly<{
    rallar: Parameters<typeof installRelicHunterGame>[0];
    store: Map<string, RelicGameState>;
    published: PublishedMessage[];
    get topicDefinition(): TopicDefinition | undefined;
    get commandHandler():
        | ((message: { payload: RelicCommand }, context: { senderId: string }) => Promise<void>)
        | undefined;
}> {
    const store = new Map<string, RelicGameState>();
    const published: PublishedMessage[] = [];
    let topicDefinition: TopicDefinition | undefined;
    let commandHandler:
        | ((message: { payload: RelicCommand }, context: { senderId: string }) => Promise<void>)
        | undefined;

    const rallar = {
        data: {
            open: vi.fn(async (name: string, options: unknown) => {
                expect(name).toBe('relic-hunter-games');
                expect(options).toEqual({
                    namespace: 'relic-hunter-v1',
                    schemaVersion: 1,
                });
                return {
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
                };
            }),
        },
        ws: {
            defineTopic: vi.fn((definition: TopicDefinition) => {
                topicDefinition = definition;
            }),
            on: vi.fn((
                _selector: unknown,
                handler: (
                    message: { payload: RelicCommand },
                    context: { senderId: string },
                ) => Promise<void>,
            ) => {
                commandHandler = handler;
            }),
            publish: vi.fn(async (message: PublishedMessage['message'], fanout: string) => {
                published.push({ message, fanout });
            }),
        },
    } as unknown as Parameters<typeof installRelicHunterGame>[0];

    return {
        rallar,
        store,
        published,
        get topicDefinition() {
            return topicDefinition;
        },
        get commandHandler() {
            return commandHandler;
        },
    };
}

function joinCommand(gameId: string): RelicCommand {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'join-expedition',
        gameId,
        username: 'Alice',
        characterId: 'nyra-vale',
    };
}
