import { Temporal } from '@js-temporal/polyfill';
import { beforeAll, describe, expect, it, vi } from 'vitest';

type SharedModule = typeof import('@shared/mod.ts');
type SharedResourceEntry = import('@shared/mod.ts').ResourceEntry;

let shared: SharedModule;

beforeAll(async () => {
    shared = await import('@shared/mod.ts');
});

describe('WsQueueBoxClientService QoS runtime', () => {
    it('sends volatile outbound messages immediately when the socket is open', async () => {
        const socket = createFakeWsSocket();
        const outbox = new shared.InMemoryQueueBox(new Map());
        const service = new shared.WsQueueBoxClientService(
            new shared.InMemoryQueueBox(new Map()),
            outbox,
            socket as never,
            {
                sessionId: 'self',
            },
        );

        const msg = shared.newALUnicastMessage(
            'self',
            {
                topicId: 'chat',
                resourceId: 'msg-1',
                contextId: 'conversation-1',
            },
            'peer-1',
            'chat.private-text.v1',
            {
                text: 'hello',
            },
        );

        const result = await service.enqueueOutboxIfAbsent(msg);

        expect(result.status).toBe('sent-immediate');
        expect(result.entries).toEqual([]);
        expect(socket.sentJsonStrings).toHaveLength(1);
        expect(JSON.parse(socket.sentJsonStrings[0]).id.msgId).toBe(msg.id.msgId);
        expect((outbox as any).data.size).toBe(0);
    });

    it('returns duplicate and does not resend the same volatile outbound message twice', async () => {
        const socket = createFakeWsSocket();
        const service = new shared.WsQueueBoxClientService(
            new shared.InMemoryQueueBox(new Map()),
            new shared.InMemoryQueueBox(new Map()),
            socket as never,
            {
                sessionId: 'self',
            },
        );
        const msg = shared.newALUnicastMessage(
            'self',
            {
                topicId: 'chat',
                resourceId: 'msg-duplicate',
                contextId: 'conversation-1',
            },
            'peer-1',
            'chat.private-text.v1',
            {
                text: 'hello once',
            },
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
        const service = new shared.WsQueueBoxClientService(
            new shared.InMemoryQueueBox(new Map()),
            outbox,
            socket as never,
            {
                sessionId: 'self',
            },
            {
                qosProvider: {
                    defaultsForMessage: (msg) => msg.payload.typeId === 'chat.private-text.v1'
                        ? {
                            durability: {
                                algo: 'local-outbox',
                                opts: {},
                            },
                        }
                        : undefined,
                },
                reconnect: shared.DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS,
            },
        );

        const msg = shared.newALUnicastMessage(
            'self',
            {
                topicId: 'chat',
                resourceId: 'msg-defaulted',
                contextId: 'conversation-1',
            },
            'peer-1',
            'chat.private-text.v1',
            {
                text: 'persist me',
            },
        );

        const result = await service.enqueueOutboxIfAbsent(msg);

        expect(result.status).toBe('enqueued');
        expect(result.entries).toHaveLength(1);
        expect(socket.sentJsonStrings).toHaveLength(0);
        expect((outbox as any).data.size).toBe(1);
    });

    it('retries outbound messages when receiver acknowledgements time out', async () => {
        vi.useFakeTimers();

        try {
            const socket = createFakeWsSocket();
            const outbox = new shared.InMemoryQueueBox(new Map());
            const service = new shared.WsQueueBoxClientService(
                new shared.InMemoryQueueBox(new Map()),
                outbox,
                socket as never,
                {
                    sessionId: 'self',
                },
            );

            const msg = shared.newALUnicastMessage(
                'self',
                {
                    topicId: 'chat',
                    resourceId: 'msg-timeout',
                    contextId: 'conversation-1',
                },
                'peer-1',
                'chat.private-text.v1',
                {
                    text: 'retry me',
                },
                {
                    qos: {
                        delivery: {
                            algo: 'at-least-once',
                        },
                        ack: {
                            algo: 'hop',
                            opts: {
                                timeoutMs: 100,
                            },
                        },
                        retry: {
                            algo: 'exp-backoff',
                            opts: {
                                maxAttempts: 1,
                            },
                        },
                    },
                },
            );

            await service.enqueueOutboxIfAbsent(msg);
            await service.dequeueOutbox(
                shared.WsQueueBoxClientService.OUTBOX_DEQUEUE_TYPES,
                createResilienceDto(),
            );

            expect(socket.sentJsonStrings).toHaveLength(1);

            await vi.advanceTimersByTimeAsync(100);

            expect(socket.sentJsonStrings).toHaveLength(2);
            expect(JSON.parse(socket.sentJsonStrings[1]).id.msgId).toBe(msg.id.msgId);

            await (service as any).handleIncomingWsMessage(
                shared.newALAckControlMessage('peer-1', 'self', msg.id.msgId, 'delivered'),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('retransmits missing ordered messages after repair controls arrive', async () => {
        const socket = createFakeWsSocket();
        const service = new shared.WsQueueBoxClientService(
            new shared.InMemoryQueueBox(new Map()),
            new shared.InMemoryQueueBox(new Map()),
            socket as never,
            {
                sessionId: 'self',
            },
        );

        const seq1 = {
            ...shared.newALUnicastMessage(
                'self',
                {
                    topicId: 'chat',
                    resourceId: 'msg-seq-1',
                    contextId: 'conversation-1',
                },
                'peer-1',
                'chat.private-text.v1',
                {
                    text: 'one',
                },
            ),
            ordering: {
                orderingKey: 'conversation-1',
                epoch: 0,
                seq: 1,
            },
        };
        const seq2 = {
            ...shared.newALUnicastMessage(
                'self',
                {
                    topicId: 'chat',
                    resourceId: 'msg-seq-2',
                    contextId: 'conversation-1',
                },
                'peer-1',
                'chat.private-text.v1',
                {
                    text: 'two',
                },
            ),
            ordering: {
                orderingKey: 'conversation-1',
                epoch: 0,
                seq: 2,
            },
        };

        await service.enqueueOutboxIfAbsent(seq1);
        await service.enqueueOutboxIfAbsent(seq2);

        const repair = shared.newALRepairControlMessage(
            'peer-1',
            'self',
            seq2.id.msgId,
            'missing-seq',
            {
                status: 'gap',
                trackKey: shared.InMemoryALOrderingStore.toTrackKey(seq1),
                seq: 2,
                expectedSeq: 1,
                lastContiguousSeq: 0,
                missingSeqs: [1],
                releasableSeqs: [],
            },
        );

        await (service as any).handleIncomingWsMessage(repair);

        expect(socket.sentJsonStrings).toHaveLength(3);
        expect(JSON.parse(socket.sentJsonStrings[2]).id.msgId).toBe(seq1.id.msgId);
    });

    it('replaces superseded queued outbound messages before dequeue', async () => {
        const socket = createFakeWsSocket();
        const outbox = new shared.InMemoryQueueBox(new Map());
        const service = new shared.WsQueueBoxClientService(
            new shared.InMemoryQueueBox(new Map()),
            outbox,
            socket as never,
            {
                sessionId: 'self',
            },
        );

        const first = shared.newALUnicastMessage(
            'self',
            {
                topicId: 'presence',
                resourceId: 'presence-1',
                contextId: 'room-1',
            },
            'peer-1',
            'presence.state.v1',
            {
                text: 'older',
            },
            {
                qos: {
                    durability: {
                        algo: 'local-outbox',
                    },
                    supersedence: {
                        algo: 'latest-wins',
                        opts: {
                            supersedenceKey: 'presence:peer-1',
                        },
                    },
                },
            },
        );
        const second = shared.newALUnicastMessage(
            'self',
            {
                topicId: 'presence',
                resourceId: 'presence-2',
                contextId: 'room-1',
            },
            'peer-1',
            'presence.state.v1',
            {
                text: 'newer',
            },
            {
                qos: {
                    durability: {
                        algo: 'local-outbox',
                    },
                    supersedence: {
                        algo: 'latest-wins',
                        opts: {
                            supersedenceKey: 'presence:peer-1',
                        },
                    },
                },
            },
        );

        const firstResult = await service.enqueueOutboxIfAbsent(first);
        const secondResult = await service.enqueueOutboxIfAbsent(second);

        expect(firstResult.status).toBe('enqueued');
        expect(secondResult.status).toBe('enqueued');
        expect((outbox as any).data.size).toBe(1);

        const stored = [...((outbox as any).data.values() as Iterable<{ resource: string }>)][0];
        expect(JSON.parse(stored.resource).id.msgId).toBe(second.id.msgId);

        await service.dequeueOutbox(
            shared.WsQueueBoxClientService.OUTBOX_DEQUEUE_TYPES,
            createResilienceDto(),
        );

        expect(socket.sentJsonStrings).toHaveLength(1);
        expect(JSON.parse(socket.sentJsonStrings[0]).id.msgId).toBe(second.id.msgId);
    });

    it('delivers exclusive inbound messages to the matching local consumer', async () => {
        const socket = createFakeWsSocket();
        const service = new shared.WsQueueBoxClientService(
            new shared.InMemoryQueueBox(new Map()),
            new shared.InMemoryQueueBox(new Map()),
            socket as never,
            {
                sessionId: 'self',
            },
        );

        const receivedByFirst: string[] = [];
        const receivedBySecond: string[] = [];
        service.onInboxMessageDo(
            'tasks.job.v1',
            {
                onMessage: async (message) => {
                    receivedByFirst.push(message.id.msgId);
                },
            },
        );
        service.onAllInboxMessagesDo(
            {
                onMessage: async (message) => {
                    receivedBySecond.push(message.id.msgId);
                },
            },
        );

        const msg = shared.newALUnicastMessage(
            'peer-1',
            {
                topicId: 'tasks',
                resourceId: 'job-1',
                contextId: 'queue-1',
            },
            'self',
            'tasks.job.v1',
            {
                text: 'claim me',
            },
            {
                qos: {
                    ownership: {
                        algo: 'exclusive',
                    },
                },
            },
        );

        await (service as any).handleIncomingWsMessage(msg);

        expect(receivedByFirst).toEqual([msg.id.msgId]);
        expect(receivedBySecond).toEqual([]);
    });

    it('suppresses superseded inbound state updates', async () => {
        const socket = createFakeWsSocket();
        const service = new shared.WsQueueBoxClientService(
            new shared.InMemoryQueueBox(new Map()),
            new shared.InMemoryQueueBox(new Map()),
            socket as never,
            {
                sessionId: 'self',
            },
        );

        const deliveredTexts: string[] = [];
        service.onInboxMessageDo(
            'presence.state.v1',
            {
                onMessage: async (message) => {
                    const payload = JSON.parse(message.payload.resource) as { text: string };
                    deliveredTexts.push(payload.text);
                },
            },
        );

        const newer = shared.newALUnicastMessage(
            'peer-1',
            {
                topicId: 'presence',
                resourceId: 'state-2',
                contextId: 'room-1',
            },
            'self',
            'presence.state.v1',
            {
                text: 'newer',
            },
            {
                qos: {
                    supersedence: {
                        algo: 'latest-wins',
                        opts: {
                            supersedenceKey: 'presence:peer-1',
                        },
                    },
                },
            },
        );
        const older = {
            ...shared.newALUnicastMessage(
                'peer-1',
                {
                    topicId: 'presence',
                    resourceId: 'state-1',
                    contextId: 'room-1',
                },
                'self',
                'presence.state.v1',
                {
                    text: 'older',
                },
                {
                    qos: {
                        supersedence: {
                            algo: 'latest-wins',
                            opts: {
                                supersedenceKey: 'presence:peer-1',
                            },
                        },
                    },
                },
            ),
            id: {
                ...newer.id,
                msgId: crypto.randomUUID(),
                ts: newer.id.ts - 1_000,
            },
            audit: {
                ...newer.audit,
                createdTs: (newer.audit?.createdTs ?? newer.id.ts) - 1_000,
            },
        };

        await (service as any).handleIncomingWsMessage(newer);
        await (service as any).handleIncomingWsMessage(older);

        expect(deliveredTexts).toEqual(['newer']);
    });

    it('replans deferred inbox delivery on dequeue and retries until overload clears', async () => {
        const socket = createFakeWsSocket();
        const inbox = new shared.InMemoryQueueBox(new Map());
        let overloaded = true;
        const service = new shared.WsQueueBoxClientService(
            inbox,
            new shared.InMemoryQueueBox(new Map()),
            socket as never,
            {
                sessionId: 'self',
            },
            {
                qosProvider: {
                    liveForMessage: () => ({
                        overloaded,
                    }),
                },
                reconnect: shared.DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS,
            },
        );

        let callbackCount = 0;
        service.onInboxMessageDo(
            'chat.private-text.v1',
            {
                onMessage: async () => {
                    callbackCount += 1;
                },
            },
        );

        const msg = shared.newALUnicastMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: 'defer-1',
                contextId: 'conversation-1',
            },
            'self',
            'chat.private-text.v1',
            {
                text: 'defer me',
            },
            {
                qos: {
                    congestion: {
                        algo: 'defer',
                        opts: {
                            priority: 2,
                        },
                    },
                },
            },
        );

        await (service as any).handleIncomingWsMessage(msg);

        expect(callbackCount).toBe(0);
        expect((inbox as any).data.size).toBe(1);

        await service.dequeueInbox(
            shared.WsQueueBoxClientService.INBOX_DEQUEUE_TYPES,
            createResilienceDto(),
        );

        const storedEntry = [...((inbox as any).data.values() as Iterable<SharedResourceEntry>)][0] as SharedResourceEntry;
        expect(callbackCount).toBe(0);
        expect(storedEntry.status).toBe(shared.EntityStatus.RETRY);

        overloaded = false;
        storedEntry.dequeueAudit = {
            ...storedEntry.dequeueAudit,
            nextTs: Temporal.Now.instant().subtract({ seconds: 1 }),
        };

        await service.dequeueInbox(
            shared.WsQueueBoxClientService.INBOX_DEQUEUE_TYPES,
            createResilienceDto(),
        );

        expect(callbackCount).toBe(1);
    });

    it('buffers ordered gaps and queues negative controls on the ws receive path', async () => {
        const socket = createFakeWsSocket();
        const outbox = new shared.InMemoryQueueBox(new Map());
        const service = new shared.WsQueueBoxClientService(
            new shared.InMemoryQueueBox(new Map()),
            outbox,
            socket as never,
            {
                sessionId: 'self',
            },
        );

        const deliveredTexts: string[] = [];
        service.onInboxMessageDo(
            'chat.message.v1',
            {
                onMessage: async (message) => {
                    const payload = JSON.parse(message.payload.resource) as { text: string };
                    deliveredTexts.push(payload.text);
                },
            },
        );

        const seq2 = shared.newALMulticastMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: 'msg-2',
                contextId: 'group-1',
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'two',
            },
            {
                seq: 2,
                reliability: 'at-least-once',
            },
        );

        const seq1 = shared.newALMulticastMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: 'msg-3',
                contextId: 'group-1',
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'one',
            },
            {
                seq: 1,
                reliability: 'at-least-once',
            },
        );

        await (service as any).handleIncomingWsMessage(seq2);

        expect(deliveredTexts).toEqual([]);
        expect((outbox as any).data.size).toBe(2);

        const queuedTypeIds = [...((outbox as any).data.values() as Iterable<{ resource: string }>)]
            .map(entry => JSON.parse(entry.resource).payload.typeId)
            .sort();

        expect(queuedTypeIds).toEqual([
            shared.AL_CONTROL_NACK_TYPE_ID,
            shared.AL_CONTROL_REPAIR_TYPE_ID,
        ].sort());

        await (service as any).handleIncomingWsMessage(seq1);

        expect(deliveredTexts).toEqual(['one', 'two']);
    });
});

function createFakeWsSocket() {
    const sentJsonStrings: string[] = [];

    return {
        ws: {
            readyState: 1,
        },
        sentJsonStrings,
        onWebSocketMessageDo() {
            return this;
        },
        onWebsocketCallbacksDo() {
            return this;
        },
        sendAsJsonString(data: string) {
            sentJsonStrings.push(data);
        },
        send(data: unknown) {
            sentJsonStrings.push(JSON.stringify(data));
        },
        connect: async () => Promise.resolve(),
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
