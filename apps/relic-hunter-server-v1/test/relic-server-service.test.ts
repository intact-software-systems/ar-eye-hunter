import {
    createRelicGame,
    RELIC_PROTOCOL_VERSION,
    RELIC_TOPICS,
    RELIC_TYPES,
    type RelicCommand,
    type RelicExpeditionSetupMetadata,
    type RelicGameState,
    type RelicRoundTransitionEvent
} from '@relic-hunters/mod.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { RallarServerWsPublishInputDto } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import { expect } from '@std/expect';
import { describe, it } from '@std/testing/bdd';
import { installRelicHunterGame } from '../src/relic-game-service.ts';
import { RELIC_EVENT_TTL_MS } from '../src/to-relic-round-transition-message.ts';
import { RELIC_SNAPSHOT_TTL_MS } from '../src/to-relic-snapshot-message.ts';

interface TopicDefinition {
    readonly topicId: string;
    readonly typeId: string;
    validate(value: JsonWireValue, context: Readonly<{ roomId?: string; roomRef?: GroupRef; }>): boolean;
}

const SESSION_USERNAMES: Readonly<Record<string, string>> = {
    'alice-session': 'Alice',
    'bob-session': 'Bob'
};

const TEST_GAME_SERVICE_OPTIONS = {
    createInitialState: (gameId: string) => Promise.resolve(createRelicGame(gameId, gameId, 1)),
    readSessionUsername: (sessionId: string) => Promise.resolve(SESSION_USERNAMES[sessionId])
};
const ROOM_ONE_GROUP_REF = {
    applicationId: DEFAULT_STATE_APPLICATION_ID,
    workspaceId: DEFAULT_STATE_WORKSPACE_ID,
    groupId: 'room-1'
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
        expect(fake.published[0].scope).toBeUndefined();
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
        const fake = createFakeRallar({ error: new Error('outbox admission failed'), topicId: undefined });
        await installRelicHunterGame(fake.rallar, TEST_GAME_SERVICE_OPTIONS);

        const warnings = await captureWarnings(async () => {
            await expect(
                fake.commandHandler?.({ payload: joinCommand('room-1') }, { senderId: 'alice-session', ...ROOM_ONE_CONTEXT })
            ).resolves.toBeUndefined();
        });

        expect(fake.store.get('room-1')?.players[0]?.playerId).toBe('alice-session');
        expect(warnings).toEqual([[
            '[relic] WS command from alice-session was applied, but its publication failed.',
            new Error('outbox admission failed')
        ]]);
    });

    it('ends a WebSocket command whose round event publish fails after its snapshot as applied, not published', async () => {
        const fake = createFakeRallar({ error: new Error('event admission failed'), topicId: RELIC_TOPICS.event });
        const service = await installRelicHunterGame(fake.rallar, TEST_GAME_SERVICE_OPTIONS);
        await service.applyCommand(joinCommand('room-1'), 'alice-session');

        const warnings = await captureWarnings(async () => {
            await expect(
                fake.commandHandler?.({ payload: startCommand('room-1') }, { senderId: 'alice-session', ...ROOM_ONE_CONTEXT })
            ).resolves.toBeUndefined();
        });

        expect(fake.store.get('room-1')?.phase).toBe('planning');
        expect(fake.published.map(toPublishedTopicId)).toEqual([RELIC_TOPICS.snapshot, RELIC_TOPICS.snapshot]);
        expect(warnings).toEqual([[
            '[relic] WS command from alice-session was applied, but its publication failed.',
            new Error('event admission failed')
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

    it('publishes a started round right after its snapshot as an ordered, receipted event on the game\'s track for the round', async () => {
        const fake = createFakeRallar();
        const service = await installRelicHunterGame(fake.rallar, TEST_GAME_SERVICE_OPTIONS);
        await service.applyCommand(joinCommand('room-1'), 'alice-session');

        const publishedAfterMs = Date.now();
        await service.applyCommand(startCommand('room-1'), 'alice-session');

        expect(fake.published.map(toPublishedTopicId)).toEqual([
            RELIC_TOPICS.snapshot,
            RELIC_TOPICS.snapshot,
            RELIC_TOPICS.event
        ]);
        const published = fake.published[2];
        expect(published).toMatchObject({
            fanout: 'outbox',
            message: {
                id: { senderId: 'relic-server' },
                route: { topicId: RELIC_TOPICS.event, contextId: 'room-1', resourceId: 'room-1:1' },
                payload: { typeId: RELIC_TYPES.event },
                targets: { mode: 'broadcast', scope: 'room', groupRef: ROOM_ONE_GROUP_REF },
                delivery: { reliability: 'at-least-once', ack: 'receiver' },
                ordering: { orderingKey: 'room-1:1', epoch: 1 }
            }
        });
        expect(published.scope).toBeUndefined();
        expect(published.message.ordering?.seq).toBeUndefined();
        const expiresAtMs = published.message.constraints?.expiresAtMs ?? 0;
        expect(expiresAtMs).toBeGreaterThanOrEqual(publishedAfterMs + RELIC_EVENT_TTL_MS);
        expect(expiresAtMs).toBeLessThanOrEqual(Date.now() + RELIC_EVENT_TTL_MS);
        expect(RELIC_EVENT_TTL_MS).toBe(60_000);
        expect(JSON.parse(published.message.payload.resource)).toEqual({
            protocolVersion: RELIC_PROTOCOL_VERSION,
            gameId: 'room-1',
            round: 1,
            phase: 'planning',
            transition: 'round-started',
            text: 'Alice started the expedition.'
        });
    });

    it('publishes the resolved round and the continued review on the tracks of their rounds, each after its snapshot', async () => {
        const fake = createFakeRallar();
        const service = await installRelicHunterGame(fake.rallar, TEST_GAME_SERVICE_OPTIONS);
        await service.applyCommand(joinCommand('room-1'), 'alice-session');
        await service.applyCommand(startCommand('room-1'), 'alice-session');

        await service.applyCommand(searchCommand('room-1'), 'alice-session');
        await service.applyCommand(continueReview('room-1'), 'alice-session');

        expect(fake.published.map(toPublishedTopicId)).toEqual([
            RELIC_TOPICS.snapshot,
            RELIC_TOPICS.snapshot,
            RELIC_TOPICS.event,
            RELIC_TOPICS.snapshot,
            RELIC_TOPICS.event,
            RELIC_TOPICS.snapshot,
            RELIC_TOPICS.event
        ]);
        expect(fake.published.filter(isRoundEvent).map(toPublishedRoundEvent)).toEqual([
            {
                resourceId: 'room-1:1',
                orderingKey: 'room-1:1',
                epoch: 1,
                round: 1,
                phase: 'planning',
                transition: 'round-started',
                text: 'Alice started the expedition.'
            },
            {
                resourceId: 'room-1:1',
                orderingKey: 'room-1:1',
                epoch: 1,
                round: 1,
                phase: 'review',
                transition: 'round-resolved',
                text: 'Round 1 actions are revealed.'
            },
            {
                resourceId: 'room-1:2',
                orderingKey: 'room-1:1',
                epoch: 2,
                round: 2,
                phase: 'planning',
                transition: 'review-continued',
                text: 'Round 2 begins.'
            }
        ]);
    });

    it('publishes the finish on the last round\'s track', async () => {
        const fake = createFakeRallar();
        const service = await installRelicHunterGame(fake.rallar, {
            ...TEST_GAME_SERVICE_OPTIONS,
            createInitialState: (gameId: string) => Promise.resolve({ ...createRelicGame(gameId, gameId, 1), maxRounds: 1 })
        });
        await service.applyCommand(joinCommand('room-1'), 'alice-session');
        await service.applyCommand(startCommand('room-1'), 'alice-session');
        await service.applyCommand(searchCommand('room-1'), 'alice-session');

        await service.applyCommand(continueReview('room-1'), 'alice-session');

        expect(fake.published.filter(isRoundEvent).map(toPublishedRoundEvent).at(-1)).toEqual({
            resourceId: 'room-1:1',
            orderingKey: 'room-1:1',
            epoch: 1,
            round: 1,
            phase: 'finished',
            transition: 'finished',
            text: 'The castle collapses as the expedition ends.'
        });
    });

    it('publishes no round event for a command or a reset that moves no phase', async () => {
        const fake = createFakeRallar();
        const service = await installRelicHunterGame(fake.rallar, TEST_GAME_SERVICE_OPTIONS);

        await service.applyCommand(joinCommand('room-1'), 'alice-session');
        await service.applyCommand(startCommand('room-1'), 'alice-session');
        await service.applyCommand(startCommand('room-1'), 'alice-session');
        await service.reset('room-1');

        expect(fake.published.map(toPublishedTopicId)).toEqual([
            RELIC_TOPICS.snapshot,
            RELIC_TOPICS.snapshot,
            RELIC_TOPICS.event,
            RELIC_TOPICS.snapshot,
            RELIC_TOPICS.snapshot
        ]);
    });

    it('starts the rounds of a reset game on the tracks of its new incarnation', async () => {
        const fake = createFakeRallar();
        const incarnations = [1_000, 2_000];
        const service = await installRelicHunterGame(fake.rallar, {
            ...TEST_GAME_SERVICE_OPTIONS,
            createInitialState: (gameId: string) => Promise.resolve(createRelicGame(gameId, gameId, incarnations.shift()))
        });
        await service.applyCommand(joinCommand('room-1'), 'alice-session');
        await service.applyCommand(startCommand('room-1'), 'alice-session');

        await service.reset('room-1');
        await service.applyCommand(joinCommand('room-1'), 'alice-session');
        await service.applyCommand(startCommand('room-1'), 'alice-session');

        expect(fake.published.filter(isRoundEvent).map(toPublishedRoundEvent).map((event) => event.orderingKey))
            .toEqual(['room-1:1000', 'room-1:2000']);
        expect(JSON.parse(fake.published.at(-2)?.message.payload.resource ?? '{}').snapshot.createdAtEpochMs).toBe(2_000);
    });

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

interface PublishedRoundEvent extends Pick<RelicRoundTransitionEvent, 'round' | 'phase' | 'transition' | 'text'> {
    readonly resourceId: string;
    readonly orderingKey: string | undefined;
    readonly epoch: number | undefined;
}

interface FakePublishFailure {
    readonly error: Error;
    /** The one topic whose publications fail; undefined fails every publication. */
    readonly topicId: string | undefined;
}

function createFakeRallar(publishFailure: FakePublishFailure | undefined = undefined): Readonly<{
    rallar: Parameters<typeof installRelicHunterGame>[0];
    store: Map<string, RelicGameState>;
    published: RallarServerWsPublishInputDto[];
    get topicDefinition(): TopicDefinition | undefined;
    get commandHandler():
        | ((message: { payload: RelicCommand; }, context: { senderId: string; roomId?: string; roomRef?: GroupRef; }) => Promise<void>)
        | undefined;
}> {
    const store = new Map<string, RelicGameState>();
    const published: RallarServerWsPublishInputDto[] = [];
    let topicDefinition: TopicDefinition | undefined;
    let commandHandler:
        | ((message: { payload: RelicCommand; }, context: { senderId: string; roomId?: string; roomRef?: GroupRef; }) => Promise<void>)
        | undefined;

    const rallar = {
        appData: createFakeAppData(store),
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
            publish: (publication: RallarServerWsPublishInputDto) => {
                if (
                    publishFailure !== undefined &&
                    (publishFailure.topicId === undefined || publishFailure.topicId === publication.message.route.topicId)
                ) {
                    return Promise.reject(publishFailure.error);
                }
                published.push(publication);
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

function startCommand(gameId: string): RelicCommand {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'start-expedition',
        gameId,
        username: 'Alice'
    };
}

function searchCommand(gameId: string): RelicCommand {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'submit-action',
        gameId,
        username: 'Alice',
        action: { kind: 'search' }
    };
}

function toPublishedTopicId(publication: RallarServerWsPublishInputDto): string {
    return publication.message.route.topicId;
}

function isRoundEvent(publication: RallarServerWsPublishInputDto): boolean {
    return publication.message.route.topicId === RELIC_TOPICS.event;
}

function toPublishedRoundEvent(publication: RallarServerWsPublishInputDto): PublishedRoundEvent {
    const event: RelicRoundTransitionEvent = JSON.parse(publication.message.payload.resource);
    return {
        resourceId: publication.message.route.resourceId,
        orderingKey: publication.message.ordering?.orderingKey,
        epoch: publication.message.ordering?.epoch,
        round: event.round,
        phase: event.phase,
        transition: event.transition,
        text: event.text
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

function createFakeAppData(store: Map<string, RelicGameState>): Parameters<typeof installRelicHunterGame>[0]['appData'] {
    return {
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
    };
}
