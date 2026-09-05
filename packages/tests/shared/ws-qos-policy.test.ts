import { Temporal } from '@js-temporal/polyfill';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import * as shared from '@shared/mod.ts';
import type { OnWebSocketMessageCallback } from '@shared/websocket/json-web-socket-client.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

afterEach(() => vi.restoreAllMocks());

describe('WsQueueBoxClientService QoS runtime', () => {
    it('sends volatile outbound messages immediately when the socket is open', async () => {
        const socket = createFakeWsSocket();
        const outbox = new shared.InMemoryQueueBox(new Map());
        const service = shared.createDefaultWsQueueBoxClientService({
            inbox: new shared.InMemoryQueueBox(new Map()),
            outbox: outbox,
            socket: socket.client,
            sessionId: 'self'
        }).enableDefaultCallbacks();
        onTestFinished(() => service.close());

        const msg = shared.newALUnicastMessage(
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
        expect(socket.sentJsonStrings).toHaveLength(1);
        expect(decodePersistedALMessage(socket.sentJsonStrings[0]).id.msgId).toBe(msg.id.msgId);
        expect((await outbox.getAllKeys()).length).toBe(0);
    });

    it('returns duplicate and does not resend the same volatile outbound message twice', async () => {
        const socket = createFakeWsSocket();
        const service = shared.createDefaultWsQueueBoxClientService({
            inbox: new shared.InMemoryQueueBox(new Map()),
            outbox: new shared.InMemoryQueueBox(new Map()),
            socket: socket.client,
            sessionId: 'self'
        }).enableDefaultCallbacks();
        onTestFinished(() => service.close());
        const msg = shared.newALUnicastMessage(
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
        expect(socket.sentJsonStrings).toHaveLength(1);
    });

    it('applies topic defaults from the qos provider on outbound sends', async () => {
        const socket = createFakeWsSocket();
        const outbox = new shared.InMemoryQueueBox(new Map());
        const service = shared.createDefaultWsQueueBoxClientService({
            inbox: new shared.InMemoryQueueBox(new Map()),
            outbox: outbox,
            socket: socket.client,
            sessionId: 'self',
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
            reconnect: shared.DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS
        }).enableDefaultCallbacks();
        onTestFinished(() => service.close());

        const msg = shared.newALUnicastMessage(
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
        expect(socket.sentJsonStrings).toHaveLength(0);
        expect((await outbox.getAllKeys()).length).toBe(1);
    });

    it('retries outbound messages when receiver acknowledgements time out', async () => {
        vi.useFakeTimers();

        try {
            const socket = createFakeWsSocket();
            const outbox = new shared.InMemoryQueueBox(new Map());
            const service = shared.createDefaultWsQueueBoxClientService({
                inbox: new shared.InMemoryQueueBox(new Map()),
                outbox: outbox,
                socket: socket.client,
                sessionId: 'self'
            }).enableDefaultCallbacks();
            onTestFinished(() => service.close());

            const msg = shared.newALUnicastMessage(
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
                shared.WsQueueBoxClientService.OUTBOX_DEQUEUE_TYPES,
                createResilienceDto()
            );

            expect(socket.sentJsonStrings).toHaveLength(1);

            await vi.advanceTimersByTimeAsync(100);

            expect(socket.sentJsonStrings).toHaveLength(2);
            expect(decodePersistedALMessage(socket.sentJsonStrings[1]).id.msgId).toBe(msg.id.msgId);

            await socket.receive(
                shared.newALAckControlMessage(
                    { v: 2, msgId: 'control-ack', ts: 0, senderId: 'peer-1' },
                    {
                        ackedMsgId: msg.id.msgId,
                        fromPeerId: 'peer-1',
                        toPeerId: 'self',
                        status: 'delivered',
                        observedAtEpochMs: 0
                    }
                )
            );
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('retransmits missing ordered messages after repair controls arrive', async () => {
        const socket = createFakeWsSocket();
        const service = shared.createDefaultWsQueueBoxClientService({
            inbox: new shared.InMemoryQueueBox(new Map()),
            outbox: new shared.InMemoryQueueBox(new Map()),
            socket: socket.client,
            sessionId: 'self'
        }).enableDefaultCallbacks();
        onTestFinished(() => service.close());

        const seq1 = {
            ...shared.newALUnicastMessage(
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
                },
                {
                    qos: { repair: { algo: 'retransmit', opts: { maxRepairs: 1 } } }
                }
            ),
            ordering: {
                orderingKey: 'conversation-1',
                epoch: 0,
                seq: 1
            }
        };
        const seq2 = {
            ...shared.newALUnicastMessage(
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
                },
                {
                    qos: { repair: { algo: 'retransmit', opts: { maxRepairs: 1 } } }
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

        const repair = shared.newALRepairControlMessage(
            { v: 2, msgId: 'control-repair', ts: 0, senderId: 'peer-1' },
            {
                msgId: seq2.id.msgId,
                fromPeerId: 'peer-1',
                toPeerId: 'self',
                reason: 'missing-seq',
                observedAtEpochMs: 0,
                orderingKey: shared.toALOrderingTrackKey(seq1),
                expectedSeq: 1,
                missingSeqs: [1]
            }
        );

        await socket.receive(repair);

        expect(socket.sentJsonStrings).toHaveLength(3);
        expect(decodePersistedALMessage(socket.sentJsonStrings[2]).id.msgId).toBe(seq1.id.msgId);
    });

    it('replaces superseded queued outbound messages before dequeue', async () => {
        const socket = createFakeWsSocket();
        const outbox = new shared.InMemoryQueueBox(new Map());
        const service = shared.createDefaultWsQueueBoxClientService({
            inbox: new shared.InMemoryQueueBox(new Map()),
            outbox: outbox,
            socket: socket.client,
            sessionId: 'self'
        }).enableDefaultCallbacks();
        onTestFinished(() => service.close());

        const first = shared.newALUnicastMessage(
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
        const second = shared.newALUnicastMessage(
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
        expect((await outbox.getAllKeys()).length).toBe(1);

        const stored = (await readQueueEntries(outbox))[0];
        expect(decodePersistedALMessage(stored.resource).id.msgId).toBe(second.id.msgId);

        await service.dequeueOutbox(
            shared.WsQueueBoxClientService.OUTBOX_DEQUEUE_TYPES,
            createResilienceDto()
        );

        expect(socket.sentJsonStrings).toHaveLength(1);
        expect(decodePersistedALMessage(socket.sentJsonStrings[0]).id.msgId).toBe(second.id.msgId);
    });

    it('delivers exclusive inbound messages to the matching local consumer', async () => {
        const socket = createFakeWsSocket();
        const service = shared.createDefaultWsQueueBoxClientService({
            inbox: new shared.InMemoryQueueBox(new Map()),
            outbox: new shared.InMemoryQueueBox(new Map()),
            socket: socket.client,
            sessionId: 'self'
        }).enableDefaultCallbacks();
        onTestFinished(() => service.close());

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

        const msg = shared.newALUnicastMessage(
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

        await socket.receive(msg);

        expect(receivedByFirst).toEqual([msg.id.msgId]);
        expect(receivedBySecond).toEqual([]);
    });

    it('suppresses superseded inbound state updates', async () => {
        const socket = createFakeWsSocket();
        const service = shared.createDefaultWsQueueBoxClientService({
            inbox: new shared.InMemoryQueueBox(new Map()),
            outbox: new shared.InMemoryQueueBox(new Map()),
            socket: socket.client,
            sessionId: 'self'
        }).enableDefaultCallbacks();
        onTestFinished(() => service.close());

        const deliveredTexts: string[] = [];
        service.onInboxMessageDo(
            'presence.state.v1',
            {
                onMessage: async (message) => {
                    deliveredTexts.push(message.payload.resource);
                }
            }
        );

        const newer = shared.newALUnicastMessage(
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
            ...shared.newALUnicastMessage(
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

        await socket.receive(newer);
        await socket.receive(older);

        expect(deliveredTexts).toEqual([newer.payload.resource]);
    });

    it('replans deferred inbox delivery on dequeue and retries until overload clears', async () => {
        const socket = createFakeWsSocket();
        const inbox = new shared.InMemoryQueueBox(new Map());
        let overloaded = true;
        const service = shared.createDefaultWsQueueBoxClientService({
            inbox: inbox,
            outbox: new shared.InMemoryQueueBox(new Map()),
            socket: socket.client,
            sessionId: 'self',
            qosProvider: {
                liveForMessage: () => ({
                    overloaded
                })
            },
            reconnect: shared.DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS
        }).enableDefaultCallbacks();
        onTestFinished(() => service.close());

        let callbackCount = 0;
        service.onInboxMessageDo(
            'chat.private-text.v1',
            {
                onMessage: async () => {
                    callbackCount += 1;
                }
            }
        );

        const msg = shared.newALUnicastMessage(
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

        await socket.receive(msg);

        expect(callbackCount).toBe(0);
        expect((await inbox.getAllKeys()).length).toBe(1);

        await service.dequeueInbox(
            shared.WsQueueBoxClientService.INBOX_DEQUEUE_TYPES,
            createResilienceDto()
        );

        const storedEntry = (await readQueueEntries(inbox))[0];
        expect(callbackCount).toBe(0);
        expect(storedEntry.status).toBe(shared.EntityStatus.RETRY);

        overloaded = false;
        storedEntry.dequeueAudit = {
            ...storedEntry.dequeueAudit,
            nextTs: Temporal.Now.instant().subtract({ seconds: 1 })
        };
        await inbox.setItem(storedEntry.key, storedEntry, { expireAtTimestamp: storedEntry.audit.expiryTs.epochMilliseconds });

        await service.dequeueInbox(
            shared.WsQueueBoxClientService.INBOX_DEQUEUE_TYPES,
            createResilienceDto()
        );

        expect(callbackCount).toBe(1);
    });

    it('buffers ordered gaps and sends volatile negative controls on the ws receive path', async () => {
        const socket = createFakeWsSocket();
        const outbox = new shared.InMemoryQueueBox(new Map());
        const service = shared.createDefaultWsQueueBoxClientService({
            inbox: new shared.InMemoryQueueBox(new Map()),
            outbox: outbox,
            socket: socket.client,
            sessionId: 'self'
        }).enableDefaultCallbacks();
        onTestFinished(() => service.close());

        const deliveredTexts: string[] = [];
        service.onInboxMessageDo(
            'chat.message.v1',
            {
                onMessage: async (message) => {
                    deliveredTexts.push(message.payload.resource);
                }
            }
        );

        const seq2 = shared.newALMulticastMessage(
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

        const seq1 = shared.newALMulticastMessage(
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

        await socket.receive(seq2);

        expect(deliveredTexts).toEqual([]);
        expect((await outbox.getAllKeys()).length).toBe(0);

        const sentTypeIds = socket.sentJsonStrings
            .map((serialized) => decodePersistedALMessage(serialized).payload.typeId)
            .sort();

        expect(sentTypeIds).toEqual([
            shared.AL_CONTROL_NACK_TYPE_ID,
            shared.AL_CONTROL_REPAIR_TYPE_ID
        ].sort());

        await socket.receive(seq1);

        expect(deliveredTexts).toEqual([seq1.payload.resource, seq2.payload.resource]);
    });
});

function createFakeWsSocket() {
    const native = new RecordingWebSocket();
    const client = new shared.JsonWebSocketClient('ws://client-qos-policy-test');
    client.ws = native;
    const callbacks: OnWebSocketMessageCallback[] = [];
    vi.spyOn(client, 'onWebSocketMessageDo').mockImplementation((_id, callback) => {
        callbacks.push(callback);
        return client;
    });
    return {
        client,
        sentJsonStrings: native.sent,
        async receive(message: shared.ALMessage): Promise<void> {
            if (callbacks.length === 0) {
                throw new Error('The service must register its websocket receive callback');
            }
            for (const callback of callbacks) {
                await callback.onMessage(message, new MessageEvent('message', { data: JSON.stringify(message) }));
            }
        }
    };
}

class RecordingWebSocket extends EventTarget implements WebSocket {
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    binaryType: BinaryType = 'blob';
    readonly bufferedAmount = 0;
    readonly extensions = '';
    readonly protocol = '';
    readonly readyState = 1;
    readonly url = 'ws://client-qos-policy-test';
    onclose = null;
    onerror = null;
    onmessage = null;
    onopen = null;
    readonly sent: string[] = [];

    close(): void {}
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        if (typeof data !== 'string') {
            throw new TypeError('The JSON transport must send text');
        }
        this.sent.push(data);
    }
}

async function readQueueEntries(queue: shared.InMemoryQueueBox): Promise<shared.ResourceEntry[]> {
    const entries: shared.ResourceEntry[] = [];
    for (const key of await queue.getAllKeys()) {
        const entry = await queue.getItem(key);
        if (entry) {
            entries.push(entry);
        }
    }
    return entries;
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
