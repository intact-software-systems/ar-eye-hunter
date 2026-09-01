import { Temporal } from '@js-temporal/polyfill';
import { newALMulticastMessage, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_NACK_TYPE_ID, AL_CONTROL_REPAIR_TYPE_ID, newALAckControlMessage, newALRepairControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { InMemoryALOrderingStore } from '@shared/al-contracts/al-runtime.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import { DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS, WsQueueBoxClientService } from '@shared/services/ws-queue-box-client-service.ts';
import { JsonWebSocketClient } from '@shared/websocket/JsonWebSocketClient.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimulatedWebSocket } from './native-websocket-fixture.ts';

const services: WsQueueBoxClientService[] = [];
beforeEach(() => {
    vi.stubGlobal('WebSocket', SimulatedWebSocket);
});
afterEach(() => {
    for (const service of services.splice(0)) {
        service.close();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    SimulatedWebSocket.instances.length = 0;
});

describe('WsQueueBoxClientService QoS runtime', () => {
    it('rejects malformed native AL envelopes before they reach an application callback', async () => {
        const socket = await createOpenWebSocketFixture();
        const inbox = new InMemoryQueueBox();
        const service = new WsQueueBoxClientService({ inbox, outbox: new InMemoryQueueBox(), socket: socket.client }, {
            sessionId: 'self'
        }).enableDefaultCallbacks();
        services.push(service);
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const delivered: string[] = [];
        service.onInboxMessageDo('message', {
            onMessage: async (message) => {
                delivered.push(message.id.msgId);
            }
        });
        const valid = newALUnicastMessage('peer', { topicId: 'test', resourceId: 'invalid', contextId: 'room' }, 'self', 'message', {});
        const malformed = { ...valid, id: { ...valid.id, v: 1 } };

        await socket.native.receive(JSON.stringify(malformed));
        expect(delivered).toEqual([]);
        expect(await inbox.getAllKeys()).toEqual([]);
    });

    it('does not transmit a corrupted persisted WS outbox envelope', async () => {
        const socket = await createOpenWebSocketFixture();
        const outbox = new InMemoryQueueBox();
        const service = new WsQueueBoxClientService({ inbox: new InMemoryQueueBox(), outbox, socket: socket.client }, {
            sessionId: 'self'
        }).enableDefaultCallbacks();
        services.push(service);
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const valid = newALUnicastMessage('self', { topicId: 'test', resourceId: 'invalid', contextId: 'room' }, 'peer', 'message', {});
        const entry = await outbox.enqueueIfAbsent({
            ...QueueBoxUtilities.toResourceEntryFromMsg(valid, WsQueueBoxClientService.OUTBOX_ENQUEUE_TYPE),
            resource: JSON.stringify({ ...valid, id: { ...valid.id, v: 1 } })
        });

        await service.dequeueOutbox(WsQueueBoxClientService.OUTBOX_DEQUEUE_TYPES, createResilienceDto());
        expect(socket.native.sent).toEqual([]);
        expect((await outbox.getItem(entry.key))?.status).toBe(EntityStatus.RETRY);
    });

    it('does not dispatch a corrupted persisted WS inbox envelope', async () => {
        const socket = await createOpenWebSocketFixture();
        const inbox = new InMemoryQueueBox();
        const service = new WsQueueBoxClientService({ inbox, outbox: new InMemoryQueueBox(), socket: socket.client }, {
            sessionId: 'self'
        }).enableDefaultCallbacks();
        services.push(service);
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const delivered: string[] = [];
        service.onInboxMessageDo('message', {
            onMessage: async (message) => {
                delivered.push(message.id.msgId);
            }
        });
        const valid = newALUnicastMessage('peer', { topicId: 'test', resourceId: 'invalid', contextId: 'room' }, 'self', 'message', {});
        const entry = await inbox.enqueueIfAbsent({
            ...QueueBoxUtilities.toResourceEntryFromMsg(valid, WsQueueBoxClientService.INBOX_ENQUEUE_TYPE),
            resource: JSON.stringify({ ...valid, id: { ...valid.id, v: 1 } })
        });

        await service.dequeueInbox(WsQueueBoxClientService.INBOX_DEQUEUE_TYPES, createResilienceDto());
        expect(delivered).toEqual([]);
        expect((await inbox.getItem(entry.key))?.status).toBe(EntityStatus.RETRY);
    });

    it('sends volatile outbound messages immediately when the socket is open', async () => {
        const socket = await createOpenWebSocketFixture();
        const outbox = new InMemoryQueueBox(new Map());
        const service = new WsQueueBoxClientService({ inbox: new InMemoryQueueBox(new Map()), outbox, socket: socket.client }, {
            sessionId: 'self'
        }).enableDefaultCallbacks();
        services.push(service);

        const msg = newALUnicastMessage(
            'self',
            {
                topicId: 'chat',
                resourceId: 'msg-1',
                contextId: 'conversation-1'
            },
            'peer-1',
            'chat.private-text.v1',
            {
                text: 'hello'
            }
        );

        const result = await service.enqueueOutboxIfAbsent(msg);

        expect(result.status).toBe('sent-immediate');
        expect(result.entries).toEqual([]);
        expect(socket.native.sent).toHaveLength(1);
        expect(decodePersistedALMessage(socket.native.sent[0]).id.msgId).toBe(msg.id.msgId);
        expect(await outbox.getAllKeys()).toEqual([]);
    });

    it('returns duplicate and does not resend the same volatile outbound message twice', async () => {
        const socket = await createOpenWebSocketFixture();
        const service = new WsQueueBoxClientService(
            { inbox: new InMemoryQueueBox(new Map()), outbox: new InMemoryQueueBox(new Map()), socket: socket.client },
            {
                sessionId: 'self'
            }
        ).enableDefaultCallbacks();
        services.push(service);
        const msg = newALUnicastMessage(
            'self',
            {
                topicId: 'chat',
                resourceId: 'msg-duplicate',
                contextId: 'conversation-1'
            },
            'peer-1',
            'chat.private-text.v1',
            {
                text: 'hello once'
            }
        );

        const first = await service.enqueueOutboxIfAbsent(msg);
        const second = await service.enqueueOutboxIfAbsent(msg);

        expect(first.status).toBe('sent-immediate');
        expect(second.status).toBe('duplicate');
        expect(second.entries).toEqual([]);
        expect(socket.native.sent).toHaveLength(1);
    });

    it('applies topic defaults from the qos provider on outbound sends', async () => {
        const socket = await createOpenWebSocketFixture();
        const outbox = new InMemoryQueueBox(new Map());
        const service = new WsQueueBoxClientService({ inbox: new InMemoryQueueBox(new Map()), outbox, socket: socket.client }, {
            sessionId: 'self'
        }, {
            qosProvider: {
                defaultsForMessage: (msg) =>
                    msg.payload.typeId === 'chat.private-text.v1'
                        ? {
                            durability: {
                                algo: 'local-outbox',
                                opts: {}
                            }
                        }
                        : undefined
            },
            reconnect: DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS
        }).enableDefaultCallbacks();
        services.push(service);

        const msg = newALUnicastMessage(
            'self',
            {
                topicId: 'chat',
                resourceId: 'msg-defaulted',
                contextId: 'conversation-1'
            },
            'peer-1',
            'chat.private-text.v1',
            {
                text: 'persist me'
            }
        );

        const result = await service.enqueueOutboxIfAbsent(msg);

        expect(result.status).toBe('enqueued');
        expect(result.entries).toHaveLength(1);
        expect(socket.native.sent).toHaveLength(0);
        expect(await outbox.getAllKeys()).toHaveLength(1);
    });

    it('retries outbound messages when receiver acknowledgements time out', async () => {
        vi.useFakeTimers();

        try {
            const socket = await createOpenWebSocketFixture();
            const outbox = new InMemoryQueueBox(new Map());
            const service = new WsQueueBoxClientService({ inbox: new InMemoryQueueBox(new Map()), outbox, socket: socket.client }, {
                sessionId: 'self'
            }).enableDefaultCallbacks();
            services.push(service);

            const msg = newALUnicastMessage(
                'self',
                {
                    topicId: 'chat',
                    resourceId: 'msg-timeout',
                    contextId: 'conversation-1'
                },
                'peer-1',
                'chat.private-text.v1',
                {
                    text: 'retry me'
                },
                {
                    qos: {
                        delivery: {
                            algo: 'at-least-once'
                        },
                        ack: {
                            algo: 'hop',
                            opts: {
                                timeoutMs: 100
                            }
                        },
                        retry: {
                            algo: 'exp-backoff',
                            opts: {
                                maxAttempts: 1
                            }
                        }
                    }
                }
            );

            await service.enqueueOutboxIfAbsent(msg);
            await service.dequeueOutbox(
                WsQueueBoxClientService.OUTBOX_DEQUEUE_TYPES,
                createResilienceDto()
            );

            expect(socket.native.sent).toHaveLength(1);

            await vi.advanceTimersByTimeAsync(100);

            expect(socket.native.sent).toHaveLength(2);
            expect(decodePersistedALMessage(socket.native.sent[1]).id.msgId).toBe(msg.id.msgId);

            await socket.native.receive(JSON.stringify(newALAckControlMessage('peer-1', 'self', msg.id.msgId, 'delivered')));
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('retransmits missing ordered messages after repair controls arrive', async () => {
        const socket = await createOpenWebSocketFixture();
        const service = new WsQueueBoxClientService(
            { inbox: new InMemoryQueueBox(new Map()), outbox: new InMemoryQueueBox(new Map()), socket: socket.client },
            {
                sessionId: 'self'
            }
        ).enableDefaultCallbacks();
        services.push(service);

        const seq1 = {
            ...newALUnicastMessage(
                'self',
                {
                    topicId: 'chat',
                    resourceId: 'msg-seq-1',
                    contextId: 'conversation-1'
                },
                'peer-1',
                'chat.private-text.v1',
                {
                    text: 'one'
                }
            ),
            ordering: {
                orderingKey: 'conversation-1',
                epoch: 0,
                seq: 1
            }
        };
        const seq2 = {
            ...newALUnicastMessage(
                'self',
                {
                    topicId: 'chat',
                    resourceId: 'msg-seq-2',
                    contextId: 'conversation-1'
                },
                'peer-1',
                'chat.private-text.v1',
                {
                    text: 'two'
                }
            ),
            ordering: {
                orderingKey: 'conversation-1',
                epoch: 0,
                seq: 2
            }
        };

        await service.enqueueOutboxIfAbsent(seq1);
        await service.enqueueOutboxIfAbsent(seq2);

        const repair = newALRepairControlMessage(
            'peer-1',
            'self',
            seq2.id.msgId,
            'missing-seq',
            {
                status: 'gap',
                trackKey: InMemoryALOrderingStore.toTrackKey(seq1),
                seq: 2,
                expectedSeq: 1,
                lastContiguousSeq: 0,
                missingSeqs: [1],
                releasableSeqs: []
            }
        );

        await socket.native.receive(JSON.stringify(repair));

        expect(socket.native.sent).toHaveLength(3);
        expect(decodePersistedALMessage(socket.native.sent[2]).id.msgId).toBe(seq1.id.msgId);
    });

    it('replaces superseded queued outbound messages before dequeue', async () => {
        const socket = await createOpenWebSocketFixture();
        const outbox = new InMemoryQueueBox(new Map());
        const service = new WsQueueBoxClientService({ inbox: new InMemoryQueueBox(new Map()), outbox, socket: socket.client }, {
            sessionId: 'self'
        }).enableDefaultCallbacks();
        services.push(service);

        const first = newALUnicastMessage(
            'self',
            {
                topicId: 'presence',
                resourceId: 'presence-1',
                contextId: 'room-1'
            },
            'peer-1',
            'presence.state.v1',
            {
                text: 'older'
            },
            {
                qos: {
                    durability: {
                        algo: 'local-outbox'
                    },
                    supersedence: {
                        algo: 'latest-wins',
                        opts: {
                            supersedenceKey: 'presence:peer-1'
                        }
                    }
                }
            }
        );
        const second = newALUnicastMessage(
            'self',
            {
                topicId: 'presence',
                resourceId: 'presence-2',
                contextId: 'room-1'
            },
            'peer-1',
            'presence.state.v1',
            {
                text: 'newer'
            },
            {
                qos: {
                    durability: {
                        algo: 'local-outbox'
                    },
                    supersedence: {
                        algo: 'latest-wins',
                        opts: {
                            supersedenceKey: 'presence:peer-1'
                        }
                    }
                }
            }
        );

        const firstResult = await service.enqueueOutboxIfAbsent(first);
        const secondResult = await service.enqueueOutboxIfAbsent(second);

        expect(firstResult.status).toBe('enqueued');
        expect(secondResult.status).toBe('enqueued');
        expect(await outbox.getAllKeys()).toHaveLength(1);

        const keys = await outbox.getAllKeys();
        const stored = await outbox.getItem(keys[0]);
        expect(stored?.resource).toBe(JSON.stringify(second));

        await service.dequeueOutbox(
            WsQueueBoxClientService.OUTBOX_DEQUEUE_TYPES,
            createResilienceDto()
        );

        expect(socket.native.sent).toHaveLength(1);
        expect(decodePersistedALMessage(socket.native.sent[0]).id.msgId).toBe(second.id.msgId);
    });

    it('delivers exclusive inbound messages to the matching local consumer', async () => {
        const socket = await createOpenWebSocketFixture();
        const service = new WsQueueBoxClientService(
            { inbox: new InMemoryQueueBox(new Map()), outbox: new InMemoryQueueBox(new Map()), socket: socket.client },
            {
                sessionId: 'self'
            }
        ).enableDefaultCallbacks();
        services.push(service);

        const receivedByFirst: string[] = [];
        const receivedBySecond: string[] = [];
        service.onInboxMessageDo(
            'tasks.job.v1',
            {
                onMessage: async (message) => {
                    receivedByFirst.push(message.id.msgId);
                }
            }
        );
        service.onAllInboxMessagesDo(
            {
                onMessage: async (message) => {
                    receivedBySecond.push(message.id.msgId);
                }
            }
        );

        const msg = newALUnicastMessage(
            'peer-1',
            {
                topicId: 'tasks',
                resourceId: 'job-1',
                contextId: 'queue-1'
            },
            'self',
            'tasks.job.v1',
            {
                text: 'claim me'
            },
            {
                qos: {
                    ownership: {
                        algo: 'exclusive'
                    }
                }
            }
        );

        await socket.native.receive(JSON.stringify(msg));

        expect(receivedByFirst).toEqual([msg.id.msgId]);
        expect(receivedBySecond).toEqual([]);
    });

    it('suppresses superseded inbound state updates', async () => {
        const socket = await createOpenWebSocketFixture();
        const service = new WsQueueBoxClientService(
            { inbox: new InMemoryQueueBox(new Map()), outbox: new InMemoryQueueBox(new Map()), socket: socket.client },
            {
                sessionId: 'self'
            }
        ).enableDefaultCallbacks();
        services.push(service);

        const deliveredTexts: string[] = [];
        service.onInboxMessageDo(
            'presence.state.v1',
            {
                onMessage: async (message) => {
                    deliveredTexts.push(message.payload.resource);
                }
            }
        );

        const newer = newALUnicastMessage(
            'peer-1',
            {
                topicId: 'presence',
                resourceId: 'state-2',
                contextId: 'room-1'
            },
            'self',
            'presence.state.v1',
            {
                text: 'newer'
            },
            {
                qos: {
                    supersedence: {
                        algo: 'latest-wins',
                        opts: {
                            supersedenceKey: 'presence:peer-1'
                        }
                    }
                }
            }
        );
        const older = {
            ...newALUnicastMessage(
                'peer-1',
                {
                    topicId: 'presence',
                    resourceId: 'state-1',
                    contextId: 'room-1'
                },
                'self',
                'presence.state.v1',
                {
                    text: 'older'
                },
                {
                    qos: {
                        supersedence: {
                            algo: 'latest-wins',
                            opts: {
                                supersedenceKey: 'presence:peer-1'
                            }
                        }
                    }
                }
            ),
            id: {
                ...newer.id,
                msgId: crypto.randomUUID(),
                ts: newer.id.ts - 1_000
            },
            audit: {
                ...newer.audit,
                createdTs: (newer.audit?.createdTs ?? newer.id.ts) - 1_000
            }
        };

        await socket.native.receive(JSON.stringify(newer));
        await socket.native.receive(JSON.stringify(older));

        expect(deliveredTexts).toEqual(['{"text":"newer"}']);
    });

    it('replans deferred inbox delivery on dequeue and retries until overload clears', async () => {
        const socket = await createOpenWebSocketFixture();
        const inbox = new InMemoryQueueBox(new Map());
        let overloaded = true;
        const service = new WsQueueBoxClientService({ inbox, outbox: new InMemoryQueueBox(new Map()), socket: socket.client }, {
            sessionId: 'self'
        }, {
            qosProvider: {
                liveForMessage: () => ({
                    overloaded
                })
            },
            reconnect: DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS
        }).enableDefaultCallbacks();
        services.push(service);

        const delivered: string[] = [];
        service.onInboxMessageDo(
            'chat.private-text.v1',
            {
                onMessage: async (message) => {
                    delivered.push(message.id.msgId);
                }
            }
        );

        const msg = newALUnicastMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: 'defer-1',
                contextId: 'conversation-1'
            },
            'self',
            'chat.private-text.v1',
            {
                text: 'defer me'
            },
            {
                qos: {
                    congestion: {
                        algo: 'defer',
                        opts: {
                            priority: 2
                        }
                    }
                }
            }
        );

        await socket.native.receive(JSON.stringify(msg));

        expect(delivered).toEqual([]);
        expect(await inbox.getAllKeys()).toHaveLength(1);

        await service.dequeueInbox(
            WsQueueBoxClientService.INBOX_DEQUEUE_TYPES,
            createResilienceDto()
        );

        const storedEntry = await inbox.getItem(msg.route);
        if (!storedEntry) {
            throw new Error('Expected deferred inbox entry');
        }
        expect(delivered).toEqual([]);
        expect(storedEntry.status).toBe(EntityStatus.RETRY);

        overloaded = false;
        await inbox.setItem(storedEntry.key, {
            ...storedEntry,
            dequeueAudit: {
                ...storedEntry.dequeueAudit,
                nextTs: Temporal.Now.instant().subtract({ seconds: 1 })
            }
        }, { expireAtTimestamp: storedEntry.audit.expiryTs.epochMilliseconds });

        await service.dequeueInbox(
            WsQueueBoxClientService.INBOX_DEQUEUE_TYPES,
            createResilienceDto()
        );

        expect(delivered).toEqual([msg.id.msgId]);
    });

    it('buffers ordered gaps and queues negative controls on the ws receive path', async () => {
        const socket = await createOpenWebSocketFixture();
        const outbox = new InMemoryQueueBox(new Map());
        const service = new WsQueueBoxClientService({ inbox: new InMemoryQueueBox(new Map()), outbox, socket: socket.client }, {
            sessionId: 'self'
        }).enableDefaultCallbacks();
        services.push(service);

        const deliveredTexts: string[] = [];
        service.onInboxMessageDo(
            'chat.message.v1',
            {
                onMessage: async (message) => {
                    deliveredTexts.push(message.payload.resource);
                }
            }
        );

        const seq2 = newALMulticastMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: 'msg-2',
                contextId: 'group-1'
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'two'
            },
            {
                seq: 2,
                reliability: 'at-least-once'
            }
        );

        const seq1 = newALMulticastMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: 'msg-3',
                contextId: 'group-1'
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'one'
            },
            {
                seq: 1,
                reliability: 'at-least-once'
            }
        );

        await socket.native.receive(JSON.stringify(seq2));

        expect(deliveredTexts).toEqual([]);
        expect(await outbox.getAllKeys()).toHaveLength(2);

        const queuedTypeIds: string[] = [];
        for (const key of await outbox.getAllKeys()) {
            const entry = await outbox.getItem(key);
            if (!entry) {
                throw new Error('Expected queued control message');
            }
            queuedTypeIds.push(decodePersistedALMessage(entry.resource).payload.typeId);
        }
        queuedTypeIds.sort();

        expect(queuedTypeIds).toEqual([
            AL_CONTROL_NACK_TYPE_ID,
            AL_CONTROL_REPAIR_TYPE_ID
        ].sort());

        await socket.native.receive(JSON.stringify(seq1));

        expect(deliveredTexts).toEqual(['{"text":"one"}', '{"text":"two"}']);
    });
});

interface OpenWebSocketFixture {
    readonly client: JsonWebSocketClient;
    readonly native: SimulatedWebSocket;
}
async function createOpenWebSocketFixture(): Promise<OpenWebSocketFixture> {
    const client = new JsonWebSocketClient('ws://test');
    const connecting = client.connect();
    await Promise.resolve();
    const native = client.ws;
    if (!(native instanceof SimulatedWebSocket)) {
        throw new Error('Expected installed native WebSocket fixture');
    }
    await native.open();
    await connecting;
    return { client, native };
}

function groupRef(groupId: string) {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId
    };
}

function createResilienceDto(): ResilienceDto {
    return ResilienceDto.toResilienceDto(
        new CircuitBreakerPolicy(
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
