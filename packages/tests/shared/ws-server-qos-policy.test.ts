import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';

(globalThis as { Temporal?: typeof Temporal }).Temporal ??= Temporal;

type SharedModule = typeof import('@shared/mod.ts');
type SharedMessage = import('@shared/mod.ts').ALMessage;
type SharedTargetResolver = import('@shared/mod.ts').WsServerTargetResolver;

let shared: SharedModule;

beforeAll(async () => {
    shared = await import('@shared/mod.ts');
});

describe('WsQueueBoxServerService QoS runtime', () => {
    it('sends volatile targeted unicast messages directly from the server outbox', async () => {
        const socket = createFakeWsServer();
        const outbox = new shared.InMemoryQueueBox(new Map());
        const service = new shared.WsQueueBoxServerService(
            new shared.InMemoryQueueBox(new Map()),
            outbox,
            socket as never,
            'server-1',
            {
                targetResolver: createTargetResolver(),
            },
        );

        const msg = shared.newALUnicastMessage(
            'server-1',
            {
                topicId: 'chat',
                resourceId: 'msg-0',
                contextId: 'room-1',
            },
            'peer-2',
            'chat.private-text.v1',
            {
                text: 'direct',
            },
        );

        const result = await service.enqueueOutboxIfAbsent(msg);

        expect(result.status).toBe('sent-immediate');
        expect(result.entries).toEqual([]);
        expect(socket.sent).toHaveLength(1);
        expect(socket.sent[0].connectionId).toBe('conn-2');
        expect(socket.sent[0].data.id.msgId).toBe(msg.id.msgId);
        expect((outbox as any).data.size).toBe(0);
    });

    it('broadcasts volatile targeted broadcast messages directly from the server outbox', async () => {
        const socket = createFakeWsServer();
        const outbox = new shared.InMemoryQueueBox(new Map());
        let providerEvaluationCount = 0;
        const service = new shared.WsQueueBoxServerService(
            new shared.InMemoryQueueBox(new Map()),
            outbox,
            socket as never,
            'server-1',
            {
                qosProvider: {
                    defaultsForMessage: () => {
                        providerEvaluationCount += 1;
                        return {
                            durability: {
                                algo: providerEvaluationCount === 1
                                    ? 'volatile'
                                    : 'local-outbox',
                                opts: {},
                            },
                        };
                    },
                },
                targetResolver: createTargetResolver(),
            },
        );

        const msg = shared.newALBroadcastMessage(
            'server-1',
            {
                topicId: 'chat',
                resourceId: 'msg-broadcast',
                contextId: 'room-1',
            },
            'room',
            'chat.message.v1',
            {
                text: 'broadcast',
            },
            {
                exceptPeerIds: ['peer-2'],
            },
        );

        const result = await service.enqueueOutboxIfAbsent(msg);

        expect(result.status).toBe('sent-immediate');
        expect(result.entries).toEqual([]);
        expect(socket.sent).toHaveLength(2);
        expect(socket.sent.map(entry => entry.connectionId).sort()).toEqual(['conn-1', 'conn-3']);
        expect(socket.sent.every(entry => entry.data.id.msgId === msg.id.msgId)).toBe(true);
        expect((outbox as any).data.size).toBe(0);
        expect(providerEvaluationCount).toBe(1);
    });

    it('reports partial live-send failures with recipient and failure counts', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            const socket = createFakeWsServer({
                failingConnectionIds: ['conn-2'],
            });
            const service = new shared.WsQueueBoxServerService(
                new shared.InMemoryQueueBox(new Map()),
                new shared.InMemoryQueueBox(new Map()),
                socket as never,
                'server-1',
                {
                    targetResolver: createTargetResolver(),
                },
            );
            const msg = shared.newALBroadcastMessage(
                'server-1',
                {
                    topicId: 'chat',
                    resourceId: 'msg-partial-failure',
                    contextId: 'room-1',
                },
                'room',
                'chat.message.v1',
                {
                    text: 'partial',
                },
            );

            const result = service.sendToTargetsWithResult(msg);

            expect(result.status).toBe('partial-failure');
            expect(result.recipientCount).toBe(3);
            expect(result.sentCount).toBe(2);
            expect(result.failedCount).toBe(1);
            expect(result.failures).toEqual([
                {
                    peerId: 'peer-2',
                    connectionId: 'conn-2',
                    reason: 'send failed',
                },
            ]);
            expect(socket.encodeCount).toBe(1);
            expect(socket.sent.map(entry => entry.connectionId).sort()).toEqual([
                'conn-1',
                'conn-3',
            ]);
        } finally {
            error.mockRestore();
        }
    });

    it('treats targeted broadcast messages with no recipients as a successful no-op', async () => {
        const socket = createFakeWsServer();
        const outbox = new shared.InMemoryQueueBox(new Map());
        const service = new shared.WsQueueBoxServerService(
            new shared.InMemoryQueueBox(new Map()),
            outbox,
            socket as never,
            'server-1',
            {
                targetResolver: {
                    ...createTargetResolver(),
                    resolveBroadcastRecipients: () => [],
                },
            },
        );

        const msg = shared.newALBroadcastMessage(
            'server-1',
            {
                topicId: 'chat',
                resourceId: 'msg-empty-broadcast',
                contextId: 'room-1',
            },
            'room',
            'chat.message.v1',
            {
                text: 'nobody hears this',
            },
        );

        const result = await service.enqueueOutboxIfAbsent(msg);

        expect(result.status).toBe('no-route');
        expect(result.entries).toEqual([]);
        expect(result.reason).toContain('Cannot resolve WS server recipients');
        expect(socket.sent).toHaveLength(0);
        expect((outbox as any).data.size).toBe(0);
    });

    it('routes targeted multicast messages to resolved group recipients', async () => {
        const socket = createFakeWsServer();
        const outbox = new shared.InMemoryQueueBox(new Map());
        const service = new shared.WsQueueBoxServerService(
            new shared.InMemoryQueueBox(new Map()),
            outbox,
            socket as never,
            'server-1',
            {
                targetResolver: createTargetResolver(),
            },
        );

        const msg = shared.newALMulticastMessage(
            'server-1',
            {
                topicId: 'chat',
                resourceId: 'msg-multi',
                contextId: 'room-1',
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'multicast',
            },
            {
                qos: {
                    durability: {
                        algo: 'volatile',
                    },
                },
            },
        );

        await service.enqueueOutboxIfAbsent(msg);

        expect(socket.sent.map(entry => entry.connectionId).sort()).toEqual(['conn-1', 'conn-2']);
        expect((outbox as any).data.size).toBe(0);
    });

    it('persists server outbox entries with the message expiry timestamp', async () => {
        const socket = createFakeWsServer();
        const outbox = new shared.InMemoryQueueBox(new Map());
        const service = new shared.WsQueueBoxServerService(
            new shared.InMemoryQueueBox(new Map()),
            outbox,
            socket as never,
            'server-1',
            {
                targetResolver: createTargetResolver(),
            },
        );
        const expiresAtMs = Date.UTC(2027, 0, 1, 0, 5, 0);
        const msg = {
            ...shared.newALUnicastMessage(
                'server-1',
                {
                    topicId: 'chat',
                    resourceId: 'msg-persisted',
                    contextId: 'room-1',
                },
                'peer-2',
                'chat.private-text.v1',
                {
                    text: 'persisted',
                },
            ),
            delivery: {
                reliability: 'at-least-once' as const,
                ack: 'receiver' as const,
            },
            constraints: {
                expiresAtMs,
            },
        };

        await service.enqueueOutboxIfAbsent(msg);

        const [stored] = [...(outbox as any).data.values()];

        expect(stored.audit.expiryTs.epochMilliseconds).toBe(expiresAtMs);
        expect(socket.sent).toHaveLength(0);

        const enqueueIfAbsent = vi.spyOn(outbox, 'enqueueIfAbsent');
        const invalidRoomMessage = shared.newALBroadcastMessage(
            'server-1',
            {
                topicId: 'room.chat',
                resourceId: 'msg-invalid-persisted-room',
                contextId: 'room-1',
            },
            'room',
            'chat.message.v1',
            { text: 'must not persist' },
            {
                reliability: 'at-least-once',
                ack: 'receiver',
            },
        );

        await expect(service.enqueueOutboxIfAbsent(invalidRoomMessage))
            .rejects.toThrow(/room broadcast group ref/i);
        expect(enqueueIfAbsent).not.toHaveBeenCalled();
        expect(await outbox.getItem(invalidRoomMessage.route)).toBeUndefined();
        expect(socket.sent).toHaveLength(0);
    });

    it('returns no-route for untargeted outbound messages instead of falling back to callbacks', async () => {
        const socket = createFakeWsServer();
        const outbox = new shared.InMemoryQueueBox(new Map());
        const service = new shared.WsQueueBoxServerService(
            new shared.InMemoryQueueBox(new Map()),
            outbox,
            socket as never,
            'server-1',
            {
                targetResolver: createTargetResolver(),
            },
        );

        let callbackCount = 0;
        service.onAllOutboxMessagesDo({
            onMessage: async () => {
                callbackCount += 1;
            },
        });

        const msg = shared.newALUntargetedMessage(
            'server-1',
            {
                topicId: 'chat',
                resourceId: 'msg-untargeted',
                contextId: 'room-1',
            },
            'chat.message.v1',
            {
                text: 'no target',
            },
        );

        const result = await service.enqueueOutboxIfAbsent(msg);

        expect(result.status).toBe('no-route');
        expect(result.reason).toContain('without explicit targets');
        expect(callbackCount).toBe(0);
        expect(socket.sent).toHaveLength(0);
        expect((outbox as any).data.size).toBe(0);
    });

    it('drops unresolved queued outbound messages instead of using callback fallback', async () => {
        const socket = createFakeWsServer();
        const outbox = new shared.InMemoryQueueBox(new Map());
        const service = new shared.WsQueueBoxServerService(
            new shared.InMemoryQueueBox(new Map()),
            outbox,
            socket as never,
            'server-1',
            {
                targetResolver: createTargetResolver(),
            },
        );

        let callbackCount = 0;
        service.onAllOutboxMessagesDo({
            onMessage: async () => {
                callbackCount += 1;
            },
        });

        const msg = shared.newALMulticastMessage(
            'server-1',
            {
                topicId: 'chat',
                resourceId: 'msg-unresolved',
                contextId: 'room-1',
            },
            groupRef('missing-group'),
            'chat.message.v1',
            {
                text: 'unknown group',
            },
            {
                reliability: 'at-least-once',
                ack: 'all-logical-recipients',
            },
        );

        await outbox.enqueue(
            shared.toResourceEntryWithKey(
                msg.route,
                shared.WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE,
                {
                    id: msg.id.senderId,
                    data: msg,
                },
            ),
        );

        await service.dequeueOutbox(
            shared.WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES,
            createResilienceDto(),
        );

        expect(callbackCount).toBe(0);
        expect(socket.sent).toHaveLength(0);
    });

    it('targets server repair retransmits to the requesting recipient', async () => {
        const socket = createFakeWsServer();
        const outbox = new shared.InMemoryQueueBox(new Map());
        const service = new shared.WsQueueBoxServerService(
            new shared.InMemoryQueueBox(new Map()),
            outbox,
            socket as never,
            'server-1',
            {
                targetResolver: createTargetResolver(),
            },
        );

        const msg = shared.newALMulticastMessage(
            'server-1',
            {
                topicId: 'chat',
                resourceId: 'msg-repair',
                contextId: 'room-1',
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'multicast',
            },
            {
                reliability: 'at-least-once',
                ack: 'all-logical-recipients',
                qos: {
                    durability: {
                        algo: 'volatile',
                    },
                },
            },
        );

        await service.enqueueOutboxIfAbsent(msg);
        await service.dequeueOutbox(
            shared.WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES,
            createResilienceDto(),
        );
        await (service as any).handleIncomingServerMessage(
            shared.newALRepairControlMessage(
                'peer-2',
                'server-1',
                msg.id.msgId,
                'retransmit',
            ),
            'conn-2',
        );

        expect(socket.sent).toHaveLength(3);
        expect(socket.sent[2].connectionId).toBe('conn-2');
        expect(socket.sent[2].data.id.msgId).toBe(msg.id.msgId);
    });

    it('forwards inbound client unicast messages to the targeted peer', async () => {
        const socket = createFakeWsServer();
        const service = new shared.WsQueueBoxServerService(
            new shared.InMemoryQueueBox(new Map()),
            new shared.InMemoryQueueBox(new Map()),
            socket as never,
            'server-1',
            {
                targetResolver: createTargetResolver(),
            },
        );

        let localDeliveries = 0;
        service.onInboxMessageDo(
            'rtc',
            {
                onMessage: async () => {
                    localDeliveries += 1;
                },
            },
        );

        const msg = shared.newALUnicastMessage(
            'peer-1',
            {
                topicId: 'rtc',
                resourceId: 'signal-1',
                contextId: 'peer-2',
            },
            'peer-2',
            'rtc',
            {
                signalType: 'Offer',
            },
        );

        await (service as any).handleIncomingServerMessage(msg, 'conn-1');

        expect(localDeliveries).toBe(0);
        expect(socket.sent).toHaveLength(1);
        expect(socket.sent[0].connectionId).toBe('conn-2');
        expect(socket.sent[0].data.id.msgId).toBe(msg.id.msgId);
    });

    it('forwards inbound room broadcasts to resolved group recipients', async () => {
        const socket = createFakeWsServer();
        const service = new shared.WsQueueBoxServerService(
            new shared.InMemoryQueueBox(new Map()),
            new shared.InMemoryQueueBox(new Map()),
            socket as never,
            'server-1',
            {
                targetResolver: createTargetResolver(),
            },
        );
        const msg = shared.newALBroadcastMessage(
            'peer-1',
            {
                topicId: 'room.manual.message',
                resourceId: 'room-broadcast-1',
                contextId: 'group-1',
            },
            'room',
            'room.manual.message',
            { text: 'hello room' },
            { groupRef: groupRef('group-1') },
        );

        await (service as any).handleIncomingServerMessage(msg, 'conn-1');

        expect(socket.sent).toHaveLength(2);
        expect(socket.sent.map((entry) => entry.connectionId).sort()).toEqual([
            'conn-2',
            'conn-3',
        ]);
        expect(socket.sent.every((entry) => entry.data.id.msgId === msg.id.msgId))
            .toBe(true);
    });

    it('suppresses duplicate inbound delivery on the server wrapper', async () => {
        const socket = createFakeWsServer();
        const service = new shared.WsQueueBoxServerService(
            new shared.InMemoryQueueBox(new Map()),
            new shared.InMemoryQueueBox(new Map()),
            socket as never,
            'server-1',
            {
                targetResolver: createTargetResolver(),
            },
        );

        const received: string[] = [];
        service.onInboxMessageDo(
            'chat.message.v1',
            {
                onMessage: async (value: SharedMessage) => {
                    received.push(value.id.msgId);
                },
            },
        );

        const msg = shared.newALUntargetedMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: 'msg-1',
                contextId: 'room-1',
            },
            'chat.message.v1',
            {
                text: 'hello',
            },
        );

        await (service as any).handleIncomingServerMessage(msg, 'conn-1');
        await (service as any).handleIncomingServerMessage(msg, 'conn-1');

        expect(received).toEqual([msg.id.msgId]);
    });

    it('emits nack and repair controls for ordered gaps on inbound server messages', async () => {
        const socket = createFakeWsServer();
        const service = new shared.WsQueueBoxServerService(
            new shared.InMemoryQueueBox(new Map()),
            new shared.InMemoryQueueBox(new Map()),
            socket as never,
            'server-1',
            {
                targetResolver: createTargetResolver(),
            },
        );

        const deliveredTexts: string[] = [];
        service.onInboxMessageDo(
            'chat.message.v1',
            {
                onMessage: async (value: SharedMessage) => {
                    const payload = JSON.parse(value.payload.resource) as { text: string };
                    deliveredTexts.push(payload.text);
                },
            },
        );

        const seq2 = {
            ...shared.newALUntargetedMessage(
                'peer-1',
                {
                    topicId: 'chat',
                    resourceId: 'msg-2',
                    contextId: 'room-1',
                },
                'chat.message.v1',
                {
                    text: 'two',
                },
            ),
            ordering: {
                orderingKey: 'room-1',
                epoch: 0,
                seq: 2,
            },
            delivery: {
                reliability: 'at-least-once' as const,
                ack: 'receiver' as const,
            },
        };

        const seq1 = {
            ...shared.newALUntargetedMessage(
                'peer-1',
                {
                    topicId: 'chat',
                    resourceId: 'msg-3',
                    contextId: 'room-1',
                },
                'chat.message.v1',
                {
                    text: 'one',
                },
            ),
            ordering: {
                orderingKey: 'room-1',
                epoch: 0,
                seq: 1,
            },
            delivery: {
                reliability: 'at-least-once' as const,
                ack: 'receiver' as const,
            },
        };

        await (service as any).handleIncomingServerMessage(seq2, 'conn-1');

        expect(deliveredTexts).toEqual([]);
        expect(socket.sent).toHaveLength(2);
        expect(socket.sent.map(entry => entry.data.payload.typeId).sort()).toEqual([
            shared.AL_CONTROL_NACK_TYPE_ID,
            shared.AL_CONTROL_REPAIR_TYPE_ID,
        ].sort());
        expect(socket.sent.every(entry => entry.connectionId === 'conn-1')).toBe(true);

        await (service as any).handleIncomingServerMessage(seq1, 'conn-1');

        expect(deliveredTexts).toEqual(['one', 'two']);
    });
});

function createFakeWsServer(
    options: Readonly<{
        failingConnectionIds?: readonly string[];
    }> = {},
) {
    const sent: Array<{ connectionId: string; data: SharedMessage }> = [];
    const broadcasts: Array<{ data: SharedMessage; recipientIds: string[] }> = [];
    const connectionIds = ['conn-1', 'conn-2', 'conn-3'];
    const failingConnectionIds = new Set(options.failingConnectionIds ?? []);
    let encodeCount = 0;

    return {
        sent,
        broadcasts,
        get encodeCount() {
            return encodeCount;
        },
        onMessageDo() {
            return this;
        },
        send(connectionId: string, data: SharedMessage) {
            this.sendEncoded(connectionId, this.encode(data));
        },
        encode(data: SharedMessage) {
            encodeCount += 1;
            return {
                text: JSON.stringify(data),
                data,
            };
        },
        sendEncoded(
            connectionId: string,
            encoded: Readonly<{ text: string; data?: SharedMessage }>,
        ) {
            if (failingConnectionIds.has(connectionId)) {
                throw new Error('send failed');
            }
            sent.push({
                connectionId,
                data: encoded.data ?? JSON.parse(encoded.text) as SharedMessage,
            });
        },
        broadcast(data: SharedMessage, filter?: (ctx: { id: string }) => boolean) {
            const recipientIds = connectionIds.filter(connectionId => filter ? filter({ id: connectionId }) : true);
            broadcasts.push({ data, recipientIds });
            return recipientIds.length;
        },
    };
}

function createTargetResolver(): SharedTargetResolver {
    const peerByConnectionId: Record<string, string> = {
        'conn-1': 'peer-1',
        'conn-2': 'peer-2',
        'conn-3': 'peer-3',
    };
    const connectionIdByPeerId: Record<string, string> = {
        'peer-1': 'conn-1',
        'peer-2': 'conn-2',
        'peer-3': 'conn-3',
    };

    return {
        resolvePeerRecipients: (peerId: string) => {
            const connectionId = connectionIdByPeerId[peerId];
            return connectionId
                ? [{
                    peerId,
                    connectionId,
                }]
                : [];
        },
        resolveGroupRecipients: (groupId: string) => {
            if (groupId !== 'group-1') {
                return [];
            }

            return ['peer-1', 'peer-2'].map(peerId => ({
                peerId,
                connectionId: connectionIdByPeerId[peerId],
            }));
        },
        resolveBroadcastRecipients: () => Object.entries(connectionIdByPeerId).map(([peerId, connectionId]) => ({
            peerId,
            connectionId,
        })),
        resolvePeerIdForConnection: (connectionId: string) => peerByConnectionId[connectionId],
    };
}

function groupRef(groupId: string) {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId,
    };
}

function createResilienceDto() {
    return shared.ResilienceDto.toResilienceDto(
        new shared.CircuitBreakerPolicy(
            10,
            Temporal.Duration.from({ seconds: 10 }),
            Temporal.Duration.from({ seconds: 10 }),
            Temporal.Duration.from({ seconds: 10 }),
        ),
        1,
        10,
        1,
        1,
    );
}
