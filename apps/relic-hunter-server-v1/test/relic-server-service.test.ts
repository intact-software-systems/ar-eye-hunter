import {
    createRelicGame,
    RELIC_PROTOCOL_VERSION,
    RELIC_TOPICS,
    RELIC_TYPES,
    type RelicCommand,
    type RelicExpeditionSetupMetadata,
    type RelicGameState
} from '@relic-hunters/mod.ts';
import { DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { expect } from '@std/expect';
import { describe, it } from '@std/testing/bdd';
import { installRelicHunterGame } from '../src/relic-game-service.ts';
import { RELIC_SNAPSHOT_TTL_MS } from '../src/to-relic-snapshot-message.ts';

interface TopicDefinition {
    readonly topicId: string;
    readonly typeId: string;
    validate(value: unknown, context: Readonly<{ roomId?: string; roomRef?: GroupRef; }>): boolean;
}

type PublishedMessage = Readonly<{
    message: Readonly<{
        id: Readonly<{ senderId: string; }>;
        route: Readonly<{ topicId: string; contextId: string; resourceId: string; }>;
        payload: Readonly<{ typeId: string; resource: string; }>;
        targets?: Readonly<{
            mode: string;
            scope?: string;
            groupRef?: Readonly<{ applicationId: string; workspaceId?: string; groupId: string; }>;
        }>;
        delivery?: Readonly<{ reliability?: string; ack?: string; }>;
        constraints?: Readonly<{ expiresAtMs?: number; }>;
    }>;
    fanout: string;
}>;

const SESSION_USERNAMES: Readonly<Record<string, string>> = {
    'alice-session': 'Alice',
    'bob-session': 'Bob'
};

const TEST_GAME_SERVICE_OPTIONS = {
    createInitialState: (gameId: string) => Promise.resolve(createRelicGame(gameId, gameId, 1)),
    readSessionUsername: (sessionId: string) => Promise.resolve(SESSION_USERNAMES[sessionId])
};
const ROOM_ONE_CONTEXT = {
    roomId: 'room-1',
    roomRef: {
        applicationId: DEFAULT_STATE_APPLICATION_ID,
        workspaceId: DEFAULT_STATE_WORKSPACE_ID,
        groupId: 'room-1'
    }
};

describe('Relic Hunter server game service', () => {
    it('registers a room-scoped command topic that rejects commands for other rooms', async () => {
        const fake = createFakeRallar();
        await installRelicHunterGame(fake.rallar, TEST_GAME_SERVICE_OPTIONS);

        expect(fake.topicDefinition).toMatchObject({
            topicId: RELIC_TOPICS.command,
            typeId: RELIC_TYPES.command,
            scope: 'room',
            fanout: 'none',
            maxPayloadBytes: 16 * 1024
        });
        expect(fake.topicDefinition?.validate(joinCommand('room-1'), { roomId: 'room-1' }))
            .toBe(false);
        expect(
            fake.topicDefinition?.validate(joinCommand('room-1'), {
                roomId: 'room-1',
                roomRef: { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'room-1' }
            })
        ).toBe(true);
        expect(fake.topicDefinition?.validate(joinCommand('room-1'), { roomId: 'room-2' }))
            .toBe(false);
        expect(fake.topicDefinition?.validate({ kind: 'join-expedition' }, { roomId: 'room-1' }))
            .toBe(false);
    });

    it('persists command results and publishes snapshots from the server through the outbox with receipts (D58, D77)', async () => {
        const fake = createFakeRallar();
        const service = await installRelicHunterGame(fake.rallar, TEST_GAME_SERVICE_OPTIONS);

        const publishedAfterMs = Date.now();
        const snapshot = await service.applyCommand(joinCommand('room-1'), 'alice-session');

        expect(snapshot.players[0]).toMatchObject({
            playerId: 'alice-session',
            username: 'Alice',
            characterId: 'nyra-vale'
        });
        expect(fake.store.get('room-1')?.players).toHaveLength(1);
        expect(fake.published).toHaveLength(1);
        expect(fake.published[0]).toMatchObject({
            fanout: 'outbox',
            message: {
                id: { senderId: 'relic-server' },
                route: { topicId: RELIC_TOPICS.snapshot, contextId: 'room-1', resourceId: 'room-1:1' },
                payload: { typeId: RELIC_TYPES.snapshot },
                targets: {
                    mode: 'broadcast',
                    scope: 'room',
                    groupRef: {
                        applicationId: DEFAULT_STATE_APPLICATION_ID,
                        workspaceId: DEFAULT_STATE_WORKSPACE_ID,
                        groupId: 'room-1'
                    }
                },
                delivery: { reliability: 'at-least-once', ack: 'receiver' }
            }
        });
        const expiresAtMs = fake.published[0].message.constraints?.expiresAtMs ?? 0;
        expect(expiresAtMs).toBeGreaterThanOrEqual(publishedAfterMs + RELIC_SNAPSHOT_TTL_MS);
        expect(expiresAtMs).toBeLessThanOrEqual(Date.now() + RELIC_SNAPSHOT_TTL_MS);
        expect(RELIC_SNAPSHOT_TTL_MS).toBe(15_000);
        expect(JSON.parse(fake.published[0].message.payload.resource).snapshot.players[0].playerId)
            .toBe('alice-session');
    });

    it('keeps game state isolated per room', async () => {
        const fake = createFakeRallar();
        const service = await installRelicHunterGame(fake.rallar, TEST_GAME_SERVICE_OPTIONS);

        await service.applyCommand(joinCommand('room-1'), 'alice-session');
        await service.applyCommand({
            ...joinCommand('room-2'),
            username: 'Bob',
            characterId: 'kael-ironstride'
        }, 'bob-session');

        await expect(service.readSnapshot('room-1')).resolves.toMatchObject({
            gameId: 'room-1',
            roomId: 'room-1',
            players: [{ playerId: 'alice-session' }]
        });
        await expect(service.readSnapshot('room-2')).resolves.toMatchObject({
            gameId: 'room-2',
            roomId: 'room-2',
            players: [{ playerId: 'bob-session' }]
        });
        expect(fake.store.get('room-1')?.players).toHaveLength(1);
        expect(fake.store.get('room-2')?.players).toHaveLength(1);
    });

    it('resets persisted room state and publishes the empty lobby snapshot', async () => {
        const fake = createFakeRallar();
        const service = await installRelicHunterGame(fake.rallar, TEST_GAME_SERVICE_OPTIONS);

        await service.applyCommand(joinCommand('room-1'), 'alice-session');
        const reset = await service.reset('room-1');

        expect(reset).toMatchObject({
            gameId: 'room-1',
            phase: 'lobby',
            players: [],
            submittedPlayerIds: []
        });
        expect(fake.store.get('room-1')?.players).toEqual([]);
        expect(fake.published).toHaveLength(2);
        const resetEvent = JSON.parse(fake.published[1].message.payload.resource);
        expect(resetEvent.snapshot).toMatchObject({
            gameId: 'room-1',
            phase: 'lobby',
            players: []
        });
    });

    it('handles WebSocket commands through the registered command handler', async () => {
        const fake = createFakeRallar();
        await installRelicHunterGame(fake.rallar, TEST_GAME_SERVICE_OPTIONS);

        await fake.commandHandler?.(
            { payload: joinCommand('room-1') },
            {
                senderId: 'alice-session',
                roomId: 'room-1',
                roomRef: { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'room-1' }
            }
        );

        expect(fake.store.get('room-1')?.players[0]?.playerId).toBe('alice-session');
        expect(fake.published).toHaveLength(1);
    });

    it('applies a WebSocket command under its sender\'s session username, never the one it carries (Q6)', async () => {
        const fake = createFakeRallar();
        await installRelicHunterGame(fake.rallar, TEST_GAME_SERVICE_OPTIONS);

        await fake.commandHandler?.({ payload: { ...joinCommand('room-1'), username: 'Mallory' } }, {
            senderId: 'alice-session',
            ...ROOM_ONE_CONTEXT
        });

        expect(fake.store.get('room-1')?.players[0]).toMatchObject({
            playerId: 'alice-session',
            username: 'Alice'
        });
    });

    it('ends a WebSocket command that breaks a rule as a value: nothing is thrown into an inbox retry (Q6, C12)', async () => {
        const fake = createFakeRallar();
        await installRelicHunterGame(fake.rallar, TEST_GAME_SERVICE_OPTIONS);

        await expect(
            fake.commandHandler?.({ payload: continueReview('room-1') }, { senderId: 'alice-session', ...ROOM_ONE_CONTEXT })
        )
            .resolves.toBeUndefined();

        expect(fake.published).toHaveLength(0);
    });

    it('ends a WebSocket command whose snapshot publish fails after the write as applied, not published (C12)', async () => {
        const fake = createFakeRallar(new Error('outbox admission failed'));
        await installRelicHunterGame(fake.rallar, TEST_GAME_SERVICE_OPTIONS);

        const warnings = await captureWarnings(async () => {
            await expect(
                fake.commandHandler?.({ payload: joinCommand('room-1') }, { senderId: 'alice-session', ...ROOM_ONE_CONTEXT })
            ).resolves.toBeUndefined();
        });

        expect(fake.store.get('room-1')?.players[0]?.playerId).toBe('alice-session');
        expect(warnings).toEqual([[
            '[relic] WS command from alice-session was applied, but its snapshot was not published.',
            new Error('outbox admission failed')
        ]]);
    });

    it('ends a WebSocket command whose session read fails as a value: nothing is thrown into an inbox retry (C12)', async () => {
        const fake = createFakeRallar();
        await installRelicHunterGame(fake.rallar, {
            ...TEST_GAME_SERVICE_OPTIONS,
            readSessionUsername: () => Promise.reject(new Error('auth store unavailable'))
        });

        const warnings = await captureWarnings(async () => {
            await expect(
                fake.commandHandler?.({ payload: joinCommand('room-1') }, { senderId: 'alice-session', ...ROOM_ONE_CONTEXT })
            ).resolves.toBeUndefined();
        });

        expect(fake.store.get('room-1')).toBeUndefined();
        expect(fake.published).toHaveLength(0);
        expect(warnings).toEqual([[
            '[relic] WS command from alice-session was not applied: its session could not be read.',
            new Error('auth store unavailable')
        ]]);
    });

    it('drops a WebSocket command whose sender has no issued session', async () => {
        const fake = createFakeRallar();
        await installRelicHunterGame(fake.rallar, TEST_GAME_SERVICE_OPTIONS);

        await fake.commandHandler?.({ payload: joinCommand('room-1') }, { senderId: 'ghost-session', ...ROOM_ONE_CONTEXT });

        expect(fake.store.get('room-1')).toBeUndefined();
        expect(fake.published).toHaveLength(0);
    });
    for (
        const [name, roomContext] of [
            ['missing', { roomId: 'room-1' }],
            ['different application', {
                roomId: 'room-1',
                roomRef: { applicationId: 'other-app', workspaceId: 'default', groupId: 'room-1' }
            }],
            ['different workspace', {
                roomId: 'room-1',
                roomRef: { applicationId: 'rallar-server', workspaceId: 'other-workspace', groupId: 'room-1' }
            }]
        ] as const
    ) {
        it(`rejects WebSocket commands from ${name} room scope before mutation`, async () => {
            const fake = createFakeRallar();
            await installRelicHunterGame(fake.rallar, TEST_GAME_SERVICE_OPTIONS);

            expect(fake.topicDefinition?.validate(joinCommand('room-1'), roomContext)).toBe(false);
            await fake.commandHandler?.(
                { payload: joinCommand('room-1') },
                { senderId: 'alice-session', ...roomContext }
            );

            expect(fake.store.has('room-1')).toBe(false);
            expect(fake.published).toEqual([]);
        });
    }

    it('uses the centralized async initializer for ensure, reset, and missing command state', async () => {
        const fake = createFakeRallar();
        const calls: string[] = [];
        const service = await installRelicHunterGame(fake.rallar, {
            readSessionUsername: TEST_GAME_SERVICE_OPTIONS.readSessionUsername,
            createInitialState: (gameId, reason) => {
                calls.push(`${reason}:${gameId}`);
                return Promise.resolve({
                    ...createRelicGame(gameId, gameId, 100 + calls.length),
                    setup: {
                        schemaVersion: 1,
                        source: 'procedural',
                        seed: `${reason}-${calls.length}`,
                        blueprintId: `${reason}-blueprint`
                    }
                });
            }
        });

        const ensured = await service.ensureSnapshot('room-1');
        expect(ensured.setup).toMatchObject({
            source: 'procedural'
        });
        // The public setup type omits `seed`; read it back as the full server-side
        // metadata contract so the leak check stays a runtime assertion.
        const ensuredSetup: RelicExpeditionSetupMetadata | undefined = ensured.setup;
        expect(ensuredSetup?.seed).toBeUndefined();

        const joined = await service.applyCommand(joinCommand('room-2'), 'alice-session');
        expect(joined.setup).toMatchObject({
            source: 'procedural'
        });
        const joinedSetup: RelicExpeditionSetupMetadata | undefined = joined.setup;
        expect(joinedSetup?.seed).toBeUndefined();

        const reset = await service.reset('room-1');
        expect(reset.setup).toMatchObject({
            source: 'procedural'
        });
        const resetSetup: RelicExpeditionSetupMetadata | undefined = reset.setup;
        expect(resetSetup?.seed).toBeUndefined();
        expect(calls).toEqual([
            'ensure:room-1',
            'command:room-2',
            'reset:room-1'
        ]);
    });
});

async function captureWarnings(run: () => Promise<void>): Promise<readonly (string | Error)[][]> {
    const warnings: (string | Error)[][] = [];
    const warn = console.warn;
    console.warn = (...values: (string | Error)[]) => {
        warnings.push(values);
    };
    try {
        await run();
    }
    finally {
        console.warn = warn;
    }
    return warnings;
}

function createFakeRallar(publishFailure: Error | undefined = undefined): Readonly<{
    rallar: Parameters<typeof installRelicHunterGame>[0];
    store: Map<string, RelicGameState>;
    published: PublishedMessage[];
    get topicDefinition(): TopicDefinition | undefined;
    get commandHandler():
        | ((message: { payload: RelicCommand; }, context: { senderId: string; roomId?: string; roomRef?: GroupRef; }) => Promise<void>)
        | undefined;
}> {
    const store = new Map<string, RelicGameState>();
    const published: PublishedMessage[] = [];
    let topicDefinition: TopicDefinition | undefined;
    let commandHandler:
        | ((message: { payload: RelicCommand; }, context: { senderId: string; roomId?: string; roomRef?: GroupRef; }) => Promise<void>)
        | undefined;

    const rallar = {
        appData: {
            open: (
                name: string,
                options: Parameters<Parameters<typeof installRelicHunterGame>[0]['appData']['open']>[1]
            ) => {
                expect(name).toBe('relic-hunter-games');
                expect(options.namespace).toBe('relic-hunter-v1');
                expect(options.codec.schemaVersion).toBe(1);
                return Promise.resolve({
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
                });
            }
        },
        ws: {
            serverPeerId: 'relic-server',
            defineTopic: (definition: TopicDefinition) => {
                topicDefinition = definition;
            },
            on: (
                _selector: Parameters<Parameters<typeof installRelicHunterGame>[0]['ws']['on']>[0],
                handler: (
                    message: { payload: RelicCommand; },
                    context: { senderId: string; roomId?: string; roomRef?: GroupRef; }
                ) => Promise<void>
            ) => {
                commandHandler = handler;
            },
            publish: (message: PublishedMessage['message'], fanout?: string) => {
                if (publishFailure !== undefined) {
                    return Promise.reject(publishFailure);
                }
                published.push({ message, fanout: fanout ?? 'live-only' });
                return Promise.resolve();
            }
        }
    };

    return {
        rallar,
        store,
        published,
        get topicDefinition() {
            return topicDefinition;
        },
        get commandHandler() {
            return commandHandler;
        }
    };
}

function joinCommand(
    gameId: string
): Extract<RelicCommand, Readonly<{ kind: 'join-expedition'; }>> {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'join-expedition',
        gameId,
        username: 'Alice',
        characterId: 'nyra-vale'
    };
}

function continueReview(gameId: string): RelicCommand {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'continue-review',
        gameId,
        username: 'Alice'
    };
}
