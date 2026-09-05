import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { decodePersistedALRecord } from '@shared/al-contracts/al-message-persistence/persisted-al-value-validation.ts';
import * as shared from '@shared/mod.ts';
import type { WsServerTargetResolver } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import {
    ConnectionContext,
    JsonWebSocketServer
} from '@shared/websocket/json-web-socket-server.ts';

describe('WsQueueBoxServerService QoS runtime', () => {
    it('sends volatile targeted unicast messages directly from the server outbox', async () => {
        const socket = createRecordingWsServer();
        const outbox = new shared.InMemoryQueueBox(new Map());
        const service = shared.createDefaultWsQueueBoxServerService({
            inbox: new shared.InMemoryQueueBox(new Map()),
            outbox: outbox,
            socket: socket,
            name: 'server-1',
            targetResolver: createTargetResolver()
        });

        const msg = shared.newALUnicastMessage(
            'server-1',
            {
                topicId: 'chat',
                resourceId: 'msg-0',
                contextId: 'room-1'
            },
            'peer-2',
            'chat.private-text.v1',
            {
                text: 'direct'
            }
        );

        const result = await service.enqueueOutboxIfAbsent(msg);

        expect(result.status).toBe('sent-immediate');
        expect(result.entries).toEqual([]);
        expect(socket.sent).toHaveLength(1);
        expect(socket.sent[0].connectionId).toBe('conn-2');
        expect(socket.sent[0].data.id.msgId).toBe(msg.id.msgId);
        expect(await outbox.getAllKeys()).toEqual([]);
    });

    it('broadcasts volatile targeted broadcast messages directly from the server outbox', async () => {
        const socket = createRecordingWsServer();
        const outbox = new shared.InMemoryQueueBox(new Map());
        let providerEvaluationCount = 0;
        const service = shared.createDefaultWsQueueBoxServerService({
            inbox: new shared.InMemoryQueueBox(new Map()),
            outbox: outbox,
            socket: socket,
            name: 'server-1',
            qosProvider: {
                defaultsForMessage: () => {
                    providerEvaluationCount += 1;
                    return {
                        durability: {
                            algo: providerEvaluationCount === 1
                                ? 'volatile'
                                : 'local-outbox',
                            opts: {}
                        }
                    };
                }
            },
            targetResolver: createTargetResolver()
        });

        const msg = shared.newALBroadcastMessage(
            'server-1',
            {
                topicId: 'chat',
                resourceId: 'msg-broadcast',
                contextId: 'room-1'
            },
            'room',
            'chat.message.v1',
            {
                text: 'broadcast'
            },
            {
                groupRef: groupRef('room-1'),
                exceptPeerIds: ['peer-2']
            }
        );

        const result = await service.enqueueOutboxIfAbsent(msg);

        expect(result.status).toBe('sent-immediate');
        expect(result.entries).toEqual([]);
        expect(socket.sent).toHaveLength(2);
        expect(socket.sent.map((entry) => entry.connectionId).sort()).toEqual(['conn-1', 'conn-3']);
        expect(socket.sent.every((entry) => entry.data.id.msgId === msg.id.msgId)).toBe(true);
        expect(await outbox.getAllKeys()).toEqual([]);
        expect(providerEvaluationCount).toBe(1);
    });

    it('reports partial live-send failures with recipient and failure counts', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            const socket = createRecordingWsServer({
                failingConnectionIds: ['conn-2']
            });
            const service = shared.createDefaultWsQueueBoxServerService({
                inbox: new shared.InMemoryQueueBox(new Map()),
                outbox: new shared.InMemoryQueueBox(new Map()),
                socket: socket,
                name: 'server-1',
                targetResolver: createTargetResolver()
            });
            const msg = shared.newALBroadcastMessage(
                'server-1',
                {
                    topicId: 'chat',
                    resourceId: 'msg-partial-failure',
                    contextId: 'room-1'
                },
                'room',
                'chat.message.v1',
                {
                    text: 'partial'
                },
                { groupRef: groupRef('room-1') }
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
                    reason: 'send failed'
                }
            ]);
            expect(socket.sent.map((entry) => entry.connectionId).sort()).toEqual([
                'conn-1',
                'conn-3'
            ]);
        }
        finally {
            error.mockRestore();
        }
    });

    it('treats targeted broadcast messages with no recipients as a successful no-op', async () => {
        const socket = createRecordingWsServer();
        const outbox = new shared.InMemoryQueueBox(new Map());
        const service = shared.createDefaultWsQueueBoxServerService({
            inbox: new shared.InMemoryQueueBox(new Map()),
            outbox: outbox,
            socket: socket,
            name: 'server-1',
            targetResolver: {
                ...createTargetResolver(),
                resolveBroadcastRecipients: () => []
            }
        });

        const msg = shared.newALBroadcastMessage(
            'server-1',
            {
                topicId: 'chat',
                resourceId: 'msg-empty-broadcast',
                contextId: 'room-1'
            },
            'room',
            'chat.message.v1',
            {
                text: 'nobody hears this'
            },
            { groupRef: groupRef('room-1') }
        );

        const result = await service.enqueueOutboxIfAbsent(msg);

        expect(result.status).toBe('no-route');
        expect(result.entries).toEqual([]);
        expect(result.reason).toContain('Cannot resolve WS server recipients');
        expect(socket.sent).toHaveLength(0);
        expect(await outbox.getAllKeys()).toEqual([]);
    });

    it('routes targeted multicast messages to resolved group recipients', async () => {
        const socket = createRecordingWsServer();
        const outbox = new shared.InMemoryQueueBox(new Map());
        const service = shared.createDefaultWsQueueBoxServerService({
            inbox: new shared.InMemoryQueueBox(new Map()),
            outbox: outbox,
            socket: socket,
            name: 'server-1',
            targetResolver: createTargetResolver()
        });

        const msg = shared.newALMulticastMessage(
            'server-1',
            {
                topicId: 'chat',
                resourceId: 'msg-multi',
                contextId: 'room-1'
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'multicast'
            },
            {
                qos: {
                    durability: {
                        algo: 'volatile'
                    }
                }
            }
        );

        await service.enqueueOutboxIfAbsent(msg);

        expect(socket.sent.map((entry) => entry.connectionId).sort()).toEqual(['conn-1', 'conn-2']);
        expect(await outbox.getAllKeys()).toEqual([]);
    });

    it('persists server outbox entries with the message expiry timestamp', async () => {
        const socket = createRecordingWsServer();
        const outbox = new shared.InMemoryQueueBox(new Map());
        const service = shared.createDefaultWsQueueBoxServerService({
            inbox: new shared.InMemoryQueueBox(new Map()),
            outbox: outbox,
            socket: socket,
            name: 'server-1',
            targetResolver: createTargetResolver()
        });
        const expiresAtMs = Date.UTC(2027, 0, 1, 0, 5, 0);
        const msg = {
            ...shared.newALUnicastMessage(
                'server-1',
                {
                    topicId: 'chat',
                    resourceId: 'msg-persisted',
                    contextId: 'room-1'
                },
                'peer-2',
                'chat.private-text.v1',
                {
                    text: 'persisted'
                }
            ),
            delivery: {
                reliability: 'at-least-once' as const,
                ack: 'receiver' as const
            },
            constraints: {
                expiresAtMs
            }
        };

        await service.enqueueOutboxIfAbsent(msg);

        const [storedKey] = await outbox.getAllKeys();
        const stored = storedKey ? await outbox.getItem(storedKey) : undefined;

        expect(stored?.audit.expiryTs.epochMilliseconds).toBe(expiresAtMs);
        expect(socket.sent).toHaveLength(0);

        const keysBeforeInvalidMessage = await outbox.getAllKeys();
        const invalidRoomMessage = shared.newALBroadcastMessage(
            'server-1',
            {
                topicId: 'room.chat',
                resourceId: 'msg-invalid-persisted-room',
                contextId: 'room-1'
            },
            'room',
            'chat.message.v1',
            { text: 'must not persist' },
            {
                reliability: 'at-least-once',
                ack: 'receiver'
            }
        );

        await expect(service.enqueueOutboxIfAbsent(invalidRoomMessage))
            .rejects.toThrow(/room broadcast group ref/i);
        expect(await outbox.getAllKeys()).toEqual(keysBeforeInvalidMessage);
        expect(await outbox.getItem(invalidRoomMessage.route)).toBeUndefined();
        expect(socket.sent).toHaveLength(0);
    });

    it('returns no-route for untargeted outbound messages', async () => {
        const socket = createRecordingWsServer();
        const outbox = new shared.InMemoryQueueBox(new Map());
        const service = shared.createDefaultWsQueueBoxServerService({
            inbox: new shared.InMemoryQueueBox(new Map()),
            outbox: outbox,
            socket: socket,
            name: 'server-1',
            targetResolver: createTargetResolver()
        });

        const msg = shared.newALUntargetedMessage(
            'server-1',
            {
                topicId: 'chat',
                resourceId: 'msg-untargeted',
                contextId: 'room-1'
            },
            'chat.message.v1',
            {
                text: 'no target'
            }
        );

        const result = await service.enqueueOutboxIfAbsent(msg);

        expect(result.status).toBe('no-route');
        expect(result.reason).toContain('without explicit targets');
        expect(socket.sent).toHaveLength(0);
        expect(await outbox.getAllKeys()).toEqual([]);
    });

    it('drops unresolved queued outbound messages', async () => {
        const socket = createRecordingWsServer();
        const outbox = new shared.InMemoryQueueBox(new Map());
        const service = shared.createDefaultWsQueueBoxServerService({
            inbox: new shared.InMemoryQueueBox(new Map()),
            outbox: outbox,
            socket: socket,
            name: 'server-1',
            targetResolver: createTargetResolver()
        });

        const msg = shared.newALMulticastMessage(
            'server-1',
            {
                topicId: 'chat',
                resourceId: 'msg-unresolved',
                contextId: 'room-1'
            },
            groupRef('missing-group'),
            'chat.message.v1',
            {
                text: 'unknown group'
            },
            {
                reliability: 'at-least-once',
                ack: 'all-logical-recipients'
            }
        );

        await outbox.enqueue(
            shared.toResourceEntryWithKey(
                msg.route,
                shared.WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE,
                {
                    id: msg.id.senderId,
                    data: msg
                }
            )
        );

        await service.dequeueOutbox(
            shared.WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES,
            createResilienceDto()
        );

        expect(socket.sent).toHaveLength(0);
    });

    it('targets server repair retransmits to the requesting recipient', async () => {
        const socket = createRecordingWsServer();
        const outbox = new shared.InMemoryQueueBox(new Map());
        const service = shared.createDefaultWsQueueBoxServerService({
            inbox: new shared.InMemoryQueueBox(new Map()),
            outbox: outbox,
            socket: socket,
            name: 'server-1',
            targetResolver: createTargetResolver()
        });

        const msg = shared.newALMulticastMessage(
            'server-1',
            {
                topicId: 'chat',
                resourceId: 'msg-repair',
                contextId: 'room-1'
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'multicast'
            },
            {
                reliability: 'at-least-once',
                ack: 'all-logical-recipients',
                qos: {
                    durability: {
                        algo: 'volatile'
                    }
                }
            }
        );

        await service.enqueueOutboxIfAbsent(msg);
        await service.dequeueOutbox(
            shared.WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES,
            createResilienceDto()
        );
        await socket.receive(
            shared.newALRepairControlMessage(
                { v: 2, msgId: 'repair-control', ts: 1, senderId: 'peer-2' },
                {
                    msgId: msg.id.msgId,
                    fromPeerId: 'peer-2',
                    toPeerId: 'server-1',
                    reason: 'retransmit',
                    observedAtEpochMs: 1
                }
            ),
            'conn-2'
        );

        expect(socket.sent).toHaveLength(3);
        expect(socket.sent[2].connectionId).toBe('conn-2');
        expect(socket.sent[2].data.id.msgId).toBe(msg.id.msgId);
    });

    it('forwards inbound client unicast messages to the targeted peer', async () => {
        const socket = createRecordingWsServer();
        const service = shared.createDefaultWsQueueBoxServerService({
            inbox: new shared.InMemoryQueueBox(new Map()),
            outbox: new shared.InMemoryQueueBox(new Map()),
            socket: socket,
            name: 'server-1',
            targetResolver: createTargetResolver()
        });

        let localDeliveries = 0;
        service.onInboxMessageDo(
            'rtc',
            {
                onMessage: async () => {
                    localDeliveries += 1;
                }
            }
        );

        const msg = shared.newALUnicastMessage(
            'peer-1',
            {
                topicId: 'rtc',
                resourceId: 'signal-1',
                contextId: 'peer-2'
            },
            'peer-2',
            'rtc',
            {
                signalType: 'Offer'
            }
        );

        await socket.receive(msg, 'conn-1');

        expect(localDeliveries).toBe(0);
        expect(socket.sent).toHaveLength(1);
        expect(socket.sent[0].connectionId).toBe('conn-2');
        expect(socket.sent[0].data.id.msgId).toBe(msg.id.msgId);
    });

    it('forwards inbound room broadcasts to resolved group recipients', async () => {
        const socket = createRecordingWsServer();
        const service = shared.createDefaultWsQueueBoxServerService({
            inbox: new shared.InMemoryQueueBox(new Map()),
            outbox: new shared.InMemoryQueueBox(new Map()),
            socket: socket,
            name: 'server-1',
            targetResolver: createTargetResolver()
        });
        service.authorizeInboundMessagesWith({
            authorize: async () => ({ authorized: true })
        });
        const msg = shared.newALBroadcastMessage(
            'peer-1',
            {
                topicId: 'room.manual.message',
                resourceId: 'room-broadcast-1',
                contextId: 'group-1'
            },
            'room',
            'room.manual.message',
            { text: 'hello room' },
            { groupRef: groupRef('group-1') }
        );

        await socket.receive(msg, 'conn-1');

        expect(socket.sent).toHaveLength(2);
        expect(socket.sent.map((entry) => entry.connectionId).sort()).toEqual([
            'conn-2',
            'conn-3'
        ]);
        expect(socket.sent.every((entry) => entry.data.id.msgId === msg.id.msgId))
            .toBe(true);
    });

    // A composition that installs the topic router owns room-scoped fanout
    // behind its room authorizer, so it opts the ALM relay out — forwarding
    // here would deliver messages the authorizer rejects.
    it('does not forward room application data when the production relay disowns room fanout', async () => {
        const socket = createRecordingWsServer();
        const service = shared.createDefaultWsQueueBoxServerService({
            inbox: new shared.InMemoryQueueBox(new Map()),
            outbox: new shared.InMemoryQueueBox(new Map()),
            socket: socket,
            name: 'server-1',
            targetResolver: createTargetResolver(),
            forwardsRoomScopedMessages: false
        });
        const msg = shared.newALBroadcastMessage(
            'peer-1',
            {
                topicId: 'room.manual.message',
                resourceId: 'room-broadcast-2',
                contextId: 'group-1'
            },
            'room',
            'room.manual.message',
            { text: 'hello room' },
            { groupRef: groupRef('group-1') }
        );

        await socket.receive(msg, 'conn-1');

        expect(socket.sent).toHaveLength(0);
    });

    it('suppresses duplicate inbound delivery on the server wrapper', async () => {
        const socket = createRecordingWsServer();
        const service = shared.createDefaultWsQueueBoxServerService({
            inbox: new shared.InMemoryQueueBox(new Map()),
            outbox: new shared.InMemoryQueueBox(new Map()),
            socket: socket,
            name: 'server-1',
            targetResolver: createTargetResolver()
        });

        const received: string[] = [];
        service.onInboxMessageDo(
            'chat.message.v1',
            {
                onMessage: async (value: ALMessage) => {
                    received.push(value.id.msgId);
                }
            }
        );

        const msg = shared.newALUntargetedMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: 'msg-1',
                contextId: 'room-1'
            },
            'chat.message.v1',
            {
                text: 'hello'
            }
        );

        await socket.receive(msg, 'conn-1');
        await socket.receive(msg, 'conn-1');

        expect(received).toEqual([msg.id.msgId]);
    });

    it('emits nack and repair controls for ordered gaps on inbound server messages', async () => {
        const socket = createRecordingWsServer();
        const service = shared.createDefaultWsQueueBoxServerService({
            inbox: new shared.InMemoryQueueBox(new Map()),
            outbox: new shared.InMemoryQueueBox(new Map()),
            socket: socket,
            name: 'server-1',
            targetResolver: createTargetResolver()
        });

        const deliveredTexts: string[] = [];
        service.onInboxMessageDo(
            'chat.message.v1',
            {
                onMessage: async (value: ALMessage) => {
                    deliveredTexts.push(readTextPayload(value.payload.resource));
                }
            }
        );

        const seq2 = {
            ...shared.newALUntargetedMessage(
                'peer-1',
                {
                    topicId: 'chat',
                    resourceId: 'msg-2',
                    contextId: 'room-1'
                },
                'chat.message.v1',
                {
                    text: 'two'
                }
            ),
            ordering: {
                orderingKey: 'room-1',
                epoch: 0,
                seq: 2
            },
            delivery: {
                reliability: 'at-least-once' as const,
                ack: 'receiver' as const
            }
        };

        const seq1 = {
            ...shared.newALUntargetedMessage(
                'peer-1',
                {
                    topicId: 'chat',
                    resourceId: 'msg-3',
                    contextId: 'room-1'
                },
                'chat.message.v1',
                {
                    text: 'one'
                }
            ),
            ordering: {
                orderingKey: 'room-1',
                epoch: 0,
                seq: 1
            },
            delivery: {
                reliability: 'at-least-once' as const,
                ack: 'receiver' as const
            }
        };

        await socket.receive(seq2, 'conn-1');

        expect(deliveredTexts).toEqual([]);
        expect(socket.sent).toHaveLength(2);
        expect(socket.sent.map((entry) => entry.data.payload.typeId).sort()).toEqual([
            shared.AL_CONTROL_NACK_TYPE_ID,
            shared.AL_CONTROL_REPAIR_TYPE_ID
        ].sort());
        expect(socket.sent.every((entry) => entry.connectionId === 'conn-1')).toBe(true);

        await socket.receive(seq1, 'conn-1');

        expect(deliveredTexts).toEqual(['one', 'two']);
    });
});

interface RecordingWsServerInput {
    readonly failingConnectionIds?: readonly string[];
}

function createRecordingWsServer(options: RecordingWsServerInput = {}): RecordingJsonWebSocketServer {
    return new RecordingJsonWebSocketServer(options.failingConnectionIds ?? []);
}

namespace RecordingJsonWebSocketServer {
    export interface RecordedSend {
        readonly connectionId: string;
        readonly data: ALMessage;
    }
}

class RecordingJsonWebSocketServer extends JsonWebSocketServer {
    readonly sent: RecordingJsonWebSocketServer.RecordedSend[] = [];
    private readonly sockets = new Map<string, ReceivingWebSocket>();

    constructor(failingConnectionIds: readonly string[]) {
        super();
        const failing = new Set(failingConnectionIds);
        for (const connectionId of ['conn-1', 'conn-2', 'conn-3']) {
            const socket = new ReceivingWebSocket();
            socket.send = (data) => {
                if (failing.has(connectionId)) {
                    throw new Error('send failed');
                }
                if (typeof data !== 'string') {
                    throw new TypeError('Expected serialized AL message');
                }
                this.sent.push({ connectionId, data: decodePersistedALMessage(data) });
            };
            this.sockets.set(connectionId, socket);
            this.addConnection(new ConnectionContext({ id: connectionId, socket }));
        }
    }

    async receive(message: ALMessage, connectionId: string): Promise<void> {
        const socket = this.sockets.get(connectionId);
        if (!socket) {
            throw new TypeError(`Unknown test connection: ${connectionId}`);
        }
        await socket.receive(message);
    }
}

class ReceivingWebSocket extends EventTarget implements WebSocket {
    readonly CONNECTING = WebSocket.CONNECTING;
    readonly OPEN = WebSocket.OPEN;
    readonly CLOSING = WebSocket.CLOSING;
    readonly CLOSED = WebSocket.CLOSED;
    readonly binaryType: BinaryType = 'blob';
    readonly bufferedAmount = 0;
    readonly extensions = '';
    readonly protocol = '';
    readonly readyState = WebSocket.OPEN;
    readonly url = 'ws://server-qos-policy-test';
    onclose = null;
    onerror = null;
    onmessage = null;
    onopen = null;
    private readonly messageListeners: EventListenerOrEventListenerObject[] = [];

    override addEventListener(
        type: string,
        callback: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions
    ): void {
        super.addEventListener(type, callback, options);
        if (type === 'message' && callback !== null) {
            this.messageListeners.push(callback);
        }
    }

    close(): void {}

    send(_data: string | ArrayBufferLike | Blob | ArrayBufferView): void {}

    async receive(message: ALMessage): Promise<void> {
        const event = new MessageEvent('message', { data: JSON.stringify(message) });
        for (const listener of this.messageListeners) {
            if (typeof listener === 'function') {
                await listener.call(this, event);
            }
            else {
                await listener.handleEvent(event);
            }
        }
    }
}

function readTextPayload(serialized: string): string {
    const value = decodePersistedALRecord(serialized, 'test text payload');
    if (typeof value.text !== 'string') {
        throw new TypeError('Expected text payload');
    }
    return value.text;
}

function createTargetResolver(): WsServerTargetResolver {
    const peerByConnectionId: Record<string, string> = {
        'conn-1': 'peer-1',
        'conn-2': 'peer-2',
        'conn-3': 'peer-3'
    };
    const connectionIdByPeerId: Record<string, string> = {
        'peer-1': 'conn-1',
        'peer-2': 'conn-2',
        'peer-3': 'conn-3'
    };

    return {
        resolvePeerRecipients: (peerId: string) => {
            const connectionId = connectionIdByPeerId[peerId];
            return connectionId
                ? [{
                    peerId,
                    connectionId
                }]
                : [];
        },
        resolveGroupRecipients: (groupId: string) => {
            if (groupId !== 'group-1') {
                return [];
            }

            return ['peer-1', 'peer-2'].map((peerId) => ({
                peerId,
                connectionId: connectionIdByPeerId[peerId]
            }));
        },
        resolveBroadcastRecipients: () =>
            Object.entries(connectionIdByPeerId).map(([peerId, connectionId]) => ({
                peerId,
                connectionId
            })),
        resolvePeerIdForConnection: (connectionId: string) => peerByConnectionId[connectionId]
    };
}

function groupRef(groupId: string) {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId
    };
}

function createResilienceDto() {
    return shared.ResilienceDto.toResilienceDto(
        new shared.CircuitBreakerPolicy(
            10,
            Temporal.Duration.from({ seconds: 10 }),
            Temporal.Duration.from({ seconds: 10 }),
            Temporal.Duration.from({ seconds: 10 })
        ),
        1,
        10,
        1,
        1
    );
}
