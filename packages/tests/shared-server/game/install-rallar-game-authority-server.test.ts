import {
    installRallarGameAuthorityServer,
    type RallarGameAuthorityServerRallarFacade,
    type RallarGameAuthorityServerWsFacade
} from '@shared-server/game/install-rallar-game-authority-server.ts';
// dprint-ignore
import {
    decodeJsonWireValue,
    type JsonWireObject,
    type JsonWireValue
} from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type {
    RallarServerWsFanout,
    RallarServerWsMessage,
    RallarServerWsMessageContext,
    RallarServerWsPayload,
    RallarServerWsPublishResult,
    RallarServerWsSelector,
    RallarServerWsTopicMetadata,
    RallarServerWsValidator
} from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    createRallarGameAuthorityEnvelope,
    isRallarGameAuthorityEnvelope,
    type RallarGameAuthorityEnvelope,
    type RallarGameAuthorityRef
} from '@shared/rallar-game/mod.ts';
// dprint-ignore
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

interface Command {
    readonly action: string;
}

interface Snapshot {
    readonly tick: number;
}

interface Event {
    readonly kind: string;
}

const roomRef: GroupRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'room-1'
};

const authority: RallarGameAuthorityRef = {
    kind: 'server',
    id: 'server-1',
    epoch: 1
};

function nowEpochMs(): number {
    return 1_000;
}

describe('Rallar Game Authority server installer', () => {
    it('defines command and sync-request topics with no fanout', async () => {
        const fake = createFakeServerRallar();

        installRallarGameAuthorityServer<Command, Snapshot, Event>({
            rallar: fake.rallar,
            protocol: 'test.authority.v1',
            topicId: 'game.authority',
            authority,
            decodeCommand,
            nowEpochMs,
            handleCommand: async () => ({ status: 'accepted' })
        });

        expect(fake.definitions).toMatchObject([
            {
                topicId: 'game.authority',
                typeId: 'game.authority.command.v1',
                scope: 'room',
                fanout: 'none'
            },
            {
                topicId: 'game.authority',
                typeId: 'game.authority.sync-request.v1',
                scope: 'room',
                fanout: 'none'
            }
        ]);

        const commandDefinition = fake.definition('game.authority.command.v1');
        expect(
            await commandDefinition.validate?.(
                toWireValue(envelope('command', 'peer-a', { action: 'move' }, 1)),
                fake.context('peer-a')
            )
        ).toBe(true);
        expect(
            await commandDefinition.validate?.(
                toWireValue({
                    ...envelope('command', 'peer-a', { action: 'move' }, 1),
                    senderId: 'peer-b'
                }),
                fake.context('peer-a')
            )
        ).toBe(false);
    });

    it('rejects invalid command envelopes before app handlers run', async () => {
        const fake = createFakeServerRallar();
        let commandHandled = false;
        installRallarGameAuthorityServer<Command, Snapshot, Event>({
            rallar: fake.rallar,
            protocol: 'test.authority.v1',
            topicId: 'game.authority',
            authority,
            decodeCommand,
            nowEpochMs,
            handleCommand: async () => {
                commandHandled = true;
                return { status: 'accepted' as const };
            }
        });

        await fake.emit(
            'game.authority.command.v1',
            'peer-a',
            {
                ...envelope('command', 'peer-a', { action: 'move' }, 1),
                protocol: 'wrong.protocol'
            }
        );

        expect(commandHandled).toBe(false);
        expect(fake.published).toHaveLength(0);
    });

    it('passes the decoded command to the game handler', async () => {
        const fake = createFakeServerRallar();
        const handledCommands: Command[] = [];
        installRallarGameAuthorityServer<Command, Snapshot, Event>({
            rallar: fake.rallar,
            protocol: 'test.authority.v1',
            topicId: 'game.authority',
            authority,
            decodeCommand,
            nowEpochMs,
            handleCommand: async ({ command }) => {
                handledCommands.push(command);
                return { status: 'accepted' as const };
            }
        });

        await fake.emit(
            'game.authority.command.v1',
            'peer-a',
            envelope('command', 'peer-a', { action: ' MOVE ' }, 1)
        );

        expect(handledCommands).toEqual([{ action: 'move' }]);
    });

    it('does not consume command sequence authority for malformed payloads', async () => {
        const fake = createFakeServerRallar();
        const handledCommands: Command[] = [];
        installRallarGameAuthorityServer<Command, Snapshot, Event>({
            rallar: fake.rallar,
            protocol: 'test.authority.v1',
            topicId: 'game.authority',
            authority,
            decodeCommand,
            nowEpochMs,
            handleCommand: async ({ command }) => {
                handledCommands.push(command);
                return { status: 'accepted' as const };
            }
        });

        await fake.emit(
            'game.authority.command.v1',
            'peer-a',
            envelope('command', 'peer-a', { action: 42 }, 1)
        );
        await fake.emit(
            'game.authority.command.v1',
            'peer-a',
            envelope('command', 'peer-a', { action: 'move' }, 1)
        );

        expect(handledCommands).toEqual([{ action: 'move' }]);
    });

    it('calls app command handler and publishes snapshots and events for accepted commands', async () => {
        const fake = createFakeServerRallar();
        const handleCommand = vi.fn(async () => ({
            status: 'accepted' as const,
            snapshot: { tick: 7 },
            events: [{ kind: 'cash-picked' }, { kind: 'score-changed' }]
        }));
        const server = installRallarGameAuthorityServer<Command, Snapshot, Event>({
            rallar: fake.rallar,
            protocol: 'test.authority.v1',
            topicId: 'game.authority',
            authority,
            decodeCommand,
            nowEpochMs,
            handleCommand
        });

        await fake.emit(
            'game.authority.command.v1',
            'peer-a',
            envelope('command', 'peer-a', { action: 'move' }, 1)
        );

        expect(handleCommand).toHaveBeenCalledWith(
            expect.objectContaining({
                command: { action: 'move' },
                roomId: 'room-1',
                senderId: 'peer-a'
            })
        );
        expect(fake.published.map((entry) => parseEnvelope(entry.message).kind))
            .toEqual(['command-result', 'snapshot', 'event', 'event']);
        expect(parseEnvelope(fake.published[0].message).payload).toEqual({
            commandSeq: 1,
            status: 'accepted'
        });
        expect(parseEnvelope(fake.published[1].message).payload).toEqual({
            tick: 7
        });
        expect(fake.published[0].message.targets).toEqual({
            mode: 'unicast',
            toPeerId: 'peer-a'
        });
        expect(fake.published[1].message.targets).toMatchObject({
            mode: 'broadcast',
            scope: 'room',
            groupRef: roomRef
        });
        expect(server.status()).toMatchObject({
            handledCommandCount: 1,
            rejectedCommandCount: 0,
            publishedSnapshotCount: 1,
            publishedEventCount: 2
        });
    });

    it('publishes the rejection reason for rejected commands', async () => {
        const fake = createFakeServerRallar();
        installRallarGameAuthorityServer<Command, Snapshot, Event>({
            rallar: fake.rallar,
            protocol: 'test.authority.v1',
            topicId: 'game.authority',
            authority,
            decodeCommand,
            nowEpochMs,
            handleCommand: async () => ({
                status: 'rejected',
                reason: 'illegal-command'
            })
        });

        await fake.emit(
            'game.authority.command.v1',
            'peer-a',
            envelope('command', 'peer-a', { action: 'cheat' }, 1)
        );

        expect(fake.published).toHaveLength(1);
        expect(parseEnvelope(fake.published[0].message)).toMatchObject({
            kind: 'command-result',
            payload: {
                commandSeq: 1,
                status: 'rejected',
                reason: 'illegal-command'
            }
        });
    });

    it('unicasts readSnapshot result to sync-request sender', async () => {
        const fake = createFakeServerRallar();
        const readSnapshot = vi.fn(async () => ({ tick: 42 }));
        installRallarGameAuthorityServer<Command, Snapshot, Event>({
            rallar: fake.rallar,
            protocol: 'test.authority.v1',
            topicId: 'game.authority',
            authority,
            decodeCommand,
            nowEpochMs,
            handleCommand: async () => ({ status: 'accepted' }),
            readSnapshot
        });

        await fake.emit(
            'game.authority.sync-request.v1',
            'peer-a',
            envelope('sync-request', 'peer-a', { reason: 'late-join' }, 1)
        );

        expect(readSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({
                payload: { reason: 'late-join' },
                roomId: 'room-1',
                senderId: 'peer-a'
            })
        );
        expect(fake.published).toHaveLength(1);
        expect(parseEnvelope(fake.published[0].message)).toMatchObject({
            kind: 'snapshot',
            payload: { tick: 42 }
        });
        expect(fake.published[0].message.targets).toEqual({
            mode: 'unicast',
            toPeerId: 'peer-a'
        });
    });

    it('publishes snapshots from one named publication input', async () => {
        const fake = createFakeServerRallar();
        const server = installRallarGameAuthorityServer<Command, Snapshot, Event>({
            rallar: fake.rallar,
            protocol: 'test.authority.v1',
            topicId: 'game.authority',
            authority,
            decodeCommand,
            nowEpochMs,
            handleCommand: async () => ({ status: 'accepted' })
        });

        await server.publishSnapshot({
            roomId: 'room-1',
            snapshot: { tick: 73 },
            roomRef,
            toPeerId: 'peer-b'
        });

        expect(parseEnvelope(fake.published[0].message)).toMatchObject({
            kind: 'snapshot',
            roomId: 'room-1',
            payload: { tick: 73 }
        });
        expect(fake.published[0].message.targets).toEqual({
            mode: 'unicast',
            toPeerId: 'peer-b'
        });
    });

    it('publishes events from one named publication input', async () => {
        const fake = createFakeServerRallar();
        const server = installRallarGameAuthorityServer<Command, Snapshot, Event>({
            rallar: fake.rallar,
            protocol: 'test.authority.v1',
            topicId: 'game.authority',
            authority,
            decodeCommand,
            nowEpochMs,
            handleCommand: async () => ({ status: 'accepted' })
        });

        await server.publishEvent({
            roomId: 'room-1',
            event: { kind: 'treasure-found' },
            roomRef
        });

        expect(parseEnvelope(fake.published[0].message)).toMatchObject({
            kind: 'event',
            roomId: 'room-1',
            payload: { kind: 'treasure-found' }
        });
        expect(fake.published[0].message.targets).toMatchObject({
            mode: 'broadcast',
            scope: 'room',
            groupRef: roomRef
        });
    });

    it('timestamps published envelopes with the configured protocol clock', async () => {
        const fake = createFakeServerRallar();
        const server = installRallarGameAuthorityServer<Command, Snapshot, Event>({
            rallar: fake.rallar,
            protocol: 'test.authority.v1',
            topicId: 'game.authority',
            authority,
            decodeCommand,
            nowEpochMs: () => 7_350,
            handleCommand: async () => ({ status: 'accepted' })
        });

        await server.publishEvent({
            roomId: 'room-1',
            event: { kind: 'clock-proof' },
            roomRef
        });

        expect(parseEnvelope(fake.published[0].message).sentAtEpochMs).toBe(7_350);
    });

    it('unsubscribes handlers and prevents later command handling on stop', async () => {
        const fake = createFakeServerRallar();
        let commandHandled = false;
        const server = installRallarGameAuthorityServer<Command, Snapshot, Event>({
            rallar: fake.rallar,
            protocol: 'test.authority.v1',
            topicId: 'game.authority',
            authority,
            decodeCommand,
            nowEpochMs,
            handleCommand: async () => {
                commandHandled = true;
                return { status: 'accepted' as const };
            }
        });

        server.stop();
        await fake.emit(
            'game.authority.command.v1',
            'peer-a',
            envelope('command', 'peer-a', { action: 'late' }, 1)
        );

        expect(commandHandled).toBe(false);
        expect(fake.handlers).toHaveLength(0);
        expect(server.status().stopped).toBe(true);
    });
});

function envelope<TPayload extends JsonWireValue>(
    kind: RallarGameAuthorityEnvelope<TPayload>['kind'],
    senderId: string,
    payload: TPayload,
    seq: number
): RallarGameAuthorityEnvelope<TPayload> {
    return createRallarGameAuthorityEnvelope({
        protocol: 'test.authority.v1',
        kind,
        roomId: 'room-1',
        senderId,
        seq,
        sentAtEpochMs: 1_000 + seq,
        authority,
        payload
    });
}

function decodeCommand(value: JsonWireValue): Command {
    if (!isJsonWireObject(value) || typeof value.action !== 'string') {
        throw new Error('Game command action must be a string');
    }

    return { action: value.action.trim().toLowerCase() };
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createFakeServerRallar() {
    const definitions: StoredTopicDefinition[] = [];
    const handlers: HandlerSubscription[] = [];
    const published: FakePublishedMessage[] = [];
    const ws = createFakeGameAuthorityWebSocket({
        definitions,
        handlers,
        published
    });
    const rallar: RallarGameAuthorityServerRallarFacade = { ws };

    return {
        definitions,
        handlers,
        published,
        ws,
        rallar,
        definition: (typeId: string) => readStoredTopicDefinition(definitions, typeId),
        context: (senderId: string) => createMessageContext(definitions, senderId),
        emit<TPayload extends JsonWireValue>(
            typeId: string,
            senderId: string,
            envelopePayload: RallarGameAuthorityEnvelope<TPayload>
        ): Promise<void> {
            return emitFakeGameAuthorityMessage({
                definitions,
                handlers,
                typeId,
                senderId,
                envelopePayload
            });
        }
    };
}

interface CreateFakeGameAuthorityWebSocketInput {
    readonly definitions: StoredTopicDefinition[];
    readonly handlers: HandlerSubscription[];
    readonly published: FakePublishedMessage[];
}

function createFakeGameAuthorityWebSocket(
    input: CreateFakeGameAuthorityWebSocketInput
): RallarGameAuthorityServerWsFacade {
    return {
        defineTopic(definition) {
            input.definitions.push({
                topicId: definition.topicId,
                typeId: definition.typeId,
                scope: definition.scope,
                maxPayloadBytes: definition.maxPayloadBytes,
                fanout: definition.fanout,
                validate: definition.validate
            });
        },
        on<T extends RallarServerWsPayload>(
            selector: RallarServerWsSelector,
            handler: (
                message: RallarServerWsMessage<T>,
                context: RallarServerWsMessageContext
            ) => void | Promise<void>
        ) {
            const subscription: HandlerSubscription = {
                selector,
                invoke(message, context) {
                    return handler(
                        { ...message, payload: message.payload as T },
                        context
                    );
                }
            };
            input.handlers.push(subscription);
            return () => {
                remove(input.handlers, subscription);
                return true;
            };
        },
        async publish(
            message: ALMessage,
            fanout?: RallarServerWsFanout
        ): Promise<RallarServerWsPublishResult> {
            input.published.push({ message, fanout });
            return {
                fanout: fanout ?? 'live-only',
                status: 'sent-live' as const,
                message,
                sentCount: 1,
                recipientCount: 1,
                failedCount: 0,
                entries: []
            };
        }
    };
}

function readStoredTopicDefinition(
    definitions: readonly StoredTopicDefinition[],
    typeId: string
): StoredTopicDefinition {
    const definition = definitions.find((candidate) => candidate.typeId === typeId);
    if (!definition) {
        throw new Error(`Missing definition for ${typeId}`);
    }
    return definition;
}

function createMessageContext(
    definitions: readonly StoredTopicDefinition[],
    senderId: string
): RallarServerWsMessageContext {
    return {
        service: {} as RallarServerWsMessageContext['service'],
        definition: definitions[0],
        roomId: 'room-1',
        roomRef,
        senderId,
        proxy: {} as RallarServerWsMessageContext['proxy']
    };
}

interface EmitFakeGameAuthorityMessageInput<TPayload extends JsonWireValue> {
    readonly definitions: readonly StoredTopicDefinition[];
    readonly handlers: readonly HandlerSubscription[];
    readonly typeId: string;
    readonly senderId: string;
    readonly envelopePayload: RallarGameAuthorityEnvelope<TPayload>;
}

async function emitFakeGameAuthorityMessage<TPayload extends JsonWireValue>(
    input: EmitFakeGameAuthorityMessageInput<TPayload>
): Promise<void> {
    const messageContext = createMessageContext(input.definitions, input.senderId);
    const wireValue = toWireValue(input.envelopePayload);
    const topicDefinition = readStoredTopicDefinition(input.definitions, input.typeId);
    if (
        topicDefinition.validate !== undefined &&
        !await topicDefinition.validate(wireValue, messageContext)
    ) {
        return;
    }

    const message: RallarServerWsMessage<JsonWireValue> = {
        payload: wireValue,
        raw: toTestALMessage(input.typeId, wireValue),
        receivedAtEpochMs: 2_000
    };
    await Promise.all(
        input.handlers
            .filter((subscription) =>
                subscription.selector.topicId === 'game.authority' &&
                subscription.selector.typeId === input.typeId
            )
            .map((subscription) => subscription.invoke(message, messageContext))
    );
}

interface FakePublishedMessage {
    readonly message: ALMessage;
    readonly fanout?: RallarServerWsFanout;
}

interface StoredTopicDefinition extends RallarServerWsTopicMetadata {
    readonly validate?: RallarServerWsValidator;
}

interface HandlerSubscription {
    readonly selector: RallarServerWsSelector;
    invoke(
        message: RallarServerWsMessage<JsonWireValue>,
        context: RallarServerWsMessageContext
    ): void | Promise<void>;
}

function parseEnvelope(message: ALMessage): RallarGameAuthorityEnvelope<JsonWireValue> {
    const value = decodeJsonWireValue(
        JSON.parse(message.payload.resource),
        'Published game authority envelope'
    );
    if (!isRallarGameAuthorityEnvelope(value, 'test.authority.v1')) {
        throw new Error('Published game authority envelope is malformed');
    }

    return value as RallarGameAuthorityEnvelope<JsonWireValue>;
}

function toWireValue(value: JsonWireValue | object): JsonWireValue {
    return decodeJsonWireValue(value, 'Game authority test wire value');
}

function toTestALMessage(typeId: string, payload: JsonWireValue): ALMessage {
    return {
        id: {
            v: 2,
            msgId: `test-${typeId}`,
            ts: 1_000,
            senderId: 'peer-a'
        },
        route: {
            topicId: 'game.authority',
            contextId: 'room-1',
            resourceId: `room-1:${typeId}`
        },
        payload: {
            typeId,
            contentType: 'application/json',
            resource: JSON.stringify(payload)
        }
    };
}

function remove<T>(values: T[], value: T): void {
    const index = values.indexOf(value);
    if (index >= 0) {
        values.splice(index, 1);
    }
}
