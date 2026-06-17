import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    type ALMessage,
    type ALOutboundAdmissionStore,
    type ALOutboundCommitBundle,
    ALOutboundMessageRuntime,
    type ALOutboundPlanner,
    createALOutboundAdmissionStore,
    createInMemoryALOutboundAdmissionState,
    EntityStatus,
    InMemoryALOrderingStore,
    InMemoryQueueBox,
    newALAckControlMessage,
    newALNackControlMessage,
    newALUnicastMessage,
    QueueBoxUtilities,
    type ResourceEntry,
} from '@shared/mod.ts';

describe('ALOutboundMessageRuntime', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('returns left when the outbound planner drops enqueue', async () => {
        const runtime = createOutboundRuntime({
            sendPreparedMessage: async () => Promise.resolve(),
            planOutgoingMessage: () => ({
                dropReason: 'No route for outbound enqueue',
                persist: false,
                preparedMessages: [],
            }),
        });

        const result = await runtime.enqueueIfAbsent(createOutboundMessage('msg-dropped'));

        expect(result.status).toBe('no-route');
        expect(result.reason).toBe('No route for outbound enqueue');
        expect(result.entries).toEqual([]);
        runtime.dispose();
    });

    it('persists an outbox entry when enqueue has no prepared transport route', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const outbox = new InMemoryQueueBox(new Map());
        const sendPreparedMessage = vi.fn(async () => Promise.resolve());
        const runtime = createOutboundRuntime({
            outbox,
            sendPreparedMessage,
            planOutgoingMessage: () => ({
                persist: false,
                preparedMessages: [],
            }),
        });

        const result = await runtime.enqueueIfAbsent(createOutboundMessage('msg-no-route'));

        expect(result.status).toBe('enqueued');
        expect(result.entries).toHaveLength(1);
        expect(sendPreparedMessage).not.toHaveBeenCalled();
        expect(await reserveOutbox(outbox)).toHaveLength(1);
        expect(warn).not.toHaveBeenCalled();
        runtime.dispose();
    });

    it('returns right with no entries for immediate prepared dispatch', async () => {
        const outbox = new InMemoryQueueBox(new Map());
        const sent: Array<Record<string, unknown>> = [];
        const runtime = createOutboundRuntime({
            outbox,
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });
            },
            planOutgoingMessage: (msg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
            }),
        });
        const msg = createOutboundMessage('msg-immediate');

        const result = await runtime.enqueueIfAbsent(msg);

        expect(result.status).toBe('sent-immediate');
        expect(result.entries).toEqual([]);
        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' },
        ]);
        expect(await reserveOutbox(outbox)).toHaveLength(0);
        runtime.dispose();
    });

    it('uses browser Web Locks around outbound commits when available', async () => {
        const requestLock = vi.fn(
            async <T>(
                _name: string,
                _options: { mode: 'exclusive' },
                callback: () => Promise<T>,
            ) => await callback(),
        );
        vi.stubGlobal('navigator', {
            locks: {
                request: requestLock,
            },
        });
        const runtime = createOutboundRuntime({
            sendPreparedMessage: async () => Promise.resolve(),
            planOutgoingMessage: () => ({
                persist: false,
                preparedMessages: [{ kind: 'send' }],
            }),
        });

        await runtime.enqueueIfAbsent(createOutboundMessage('msg-web-lock'));

        expect(requestLock).toHaveBeenCalledWith(
            'rallar:al-outbound-commit:self',
            { mode: 'exclusive' },
            expect.any(Function),
        );
        runtime.dispose();
    });

    it('returns an outbox entry when enqueue is persistent', async () => {
        const outbox = new InMemoryQueueBox(new Map());
        const runtime = createOutboundRuntime({
            outbox,
            sendPreparedMessage: async () => Promise.resolve(),
            planOutgoingMessage: () => ({
                persist: true,
                preparedMessages: [],
            }),
        });
        const msg = createOutboundMessage('msg-persisted');

        const result = await runtime.enqueueIfAbsent(msg);

        expect(result.status).toBe('enqueued');
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]?.key.resourceId).toBe('msg-persisted');
        const stored = await reserveOutbox(outbox);
        expect(stored).toHaveLength(1);
        expect(JSON.parse(stored[0]?.resource ?? '{}')).toMatchObject({
            id: {
                msgId: msg.id.msgId,
            },
        });
        runtime.dispose();
    });

    it('returns duplicate with the existing outbox entry when a persistent message is enqueued twice', async () => {
        const outbox = new InMemoryQueueBox(new Map());
        const runtime = createOutboundRuntime({
            outbox,
            sendPreparedMessage: async () => Promise.resolve(),
            planOutgoingMessage: () => ({
                persist: true,
                preparedMessages: [],
            }),
        });
        const msg = createOutboundMessage('msg-duplicate');

        const first = await runtime.enqueueIfAbsent(msg);
        const second = await runtime.enqueueIfAbsent(msg);

        expect(first.status).toBe('enqueued');
        expect(second.status).toBe('duplicate');
        expect(second.entry?.key.resourceId).toBe('msg-duplicate');
        expect(second.entries).toHaveLength(1);
        expect(await reserveOutbox(outbox)).toHaveLength(1);
        runtime.dispose();
    });

    it('returns superseded with no entries when an older superseded message is enqueued', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const outbox = new InMemoryQueueBox(new Map());
        const runtime = createOutboundRuntime({
            outbox,
            sendPreparedMessage: async () => Promise.resolve(),
            planOutgoingMessage: (msg) => ({
                persist: true,
                preparedMessages: [],
                supersedenceTracking: {
                    enabled: true,
                    algo: 'latest-wins',
                    key: `presence:${msg.route.contextId}`,
                },
            }),
        });
        const newer = {
            ...createOutboundMessage('msg-supersedence-newer'),
            ordering: {
                orderingKey: 'presence',
                epoch: 0,
                seq: 2,
            },
        };
        const older = {
            ...createOutboundMessage('msg-supersedence-older'),
            ordering: {
                orderingKey: 'presence',
                epoch: 0,
                seq: 1,
            },
        };

        await enqueueOutboundOrThrow(runtime, newer);
        const superseded = await runtime.enqueueIfAbsent(older);

        expect(superseded.status).toBe('superseded');
        expect(superseded.entries).toEqual([]);
        expect(warn).toHaveBeenCalledWith(
            `Skipping superseded outbound message ${older.id.msgId}`,
        );
        const stored = await reserveOutbox(outbox);
        expect(stored).toHaveLength(1);
        expect(JSON.parse(stored[0]?.resource ?? '{}')).toMatchObject({
            id: {
                msgId: newer.id.msgId,
            },
        });
        runtime.dispose();
    });

    it('triggers repair dispatches after acknowledgement timeouts', async () => {
        vi.useFakeTimers();

        const sent: Array<Record<string, unknown>> = [];
        const runtime = createOutboundRuntime({
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });
            },
            planOutgoingMessage: (msg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
                ackTracking: {
                    enabled: true,
                    timeoutMs: 100,
                    maxAttempts: 1,
                    expectedPeerIds: ['peer-1'],
                },
                repairTracking: {
                    enabled: true,
                    algo: 'retransmit',
                    maxAttempts: 1,
                },
            }),
            planRepairMessage: async (msg, request) => ({
                persist: false,
                preparedMessages: [
                    {
                        kind: 'repair',
                        msgId: msg.id.msgId,
                        trigger: request.trigger,
                    },
                ],
            }),
        });

        const msg = createOutboundMessage('msg-timeout');

        await enqueueOutboundOrThrow(runtime, msg);
        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' },
        ]);

        await vi.advanceTimersByTimeAsync(100);

        expect(sent[1]).toMatchObject({
            kind: 'repair',
            msgId: msg.id.msgId,
            trigger: 'ack-timeout',
            phase: 'immediate',
        });

        await vi.advanceTimersByTimeAsync(100);
        expect(sent).toHaveLength(2);

        runtime.dispose();
    });

    it('stops pending acknowledgement timers when disposed', async () => {
        vi.useFakeTimers();

        const sent: Array<Record<string, unknown>> = [];
        const runtime = createOutboundRuntime({
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });
            },
            planOutgoingMessage: (msg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
                ackTracking: {
                    enabled: true,
                    timeoutMs: 100,
                    maxAttempts: 1,
                    expectedPeerIds: ['peer-1'],
                },
            }),
            planRepairMessage: async (msg) => ({
                persist: false,
                preparedMessages: [{ kind: 'repair', msgId: msg.id.msgId }],
            }),
        });

        await enqueueOutboundOrThrow(runtime, createOutboundMessage('msg-dispose'));
        runtime.dispose();

        await vi.advanceTimersByTimeAsync(200);
        expect(sent).toHaveLength(1);
    });

    it('retransmits cached missing ordered messages when a gap nack arrives', async () => {
        const sent: Array<Record<string, unknown>> = [];
        const runtime = createOutboundRuntime({
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });
            },
            planOutgoingMessage: (msg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
                repairTracking: {
                    enabled: false,
                    algo: 'none',
                    maxAttempts: 0,
                },
            }),
        });

        const seq1 = {
            ...createOutboundMessage('msg-seq-1'),
            ordering: {
                orderingKey: 'conversation-1',
                epoch: 0,
                seq: 1,
            },
        };
        const seq2 = {
            ...createOutboundMessage('msg-seq-2'),
            ordering: {
                orderingKey: 'conversation-1',
                epoch: 0,
                seq: 2,
            },
        };

        await enqueueOutboundOrThrow(runtime, seq1);
        await enqueueOutboundOrThrow(runtime, seq2);

        await runtime.acceptControlMessage(
            newALNackControlMessage('peer-1', 'self', seq2.id.msgId, 'gap', {
                status: 'gap',
                trackKey: InMemoryALOrderingStore.toTrackKey(seq1),
                seq: 2,
                expectedSeq: 1,
                lastContiguousSeq: 0,
                missingSeqs: [1],
                releasableSeqs: [],
            }),
        );

        expect(sent.map((entry) => entry.msgId)).toEqual([
            seq1.id.msgId,
            seq2.id.msgId,
            seq1.id.msgId,
        ]);
    });

    it('retries cached messages shortly after a not-yet-in-sync nack', async () => {
        vi.useFakeTimers();

        const sent: Array<Record<string, unknown>> = [];
        const runtime = createOutboundRuntime({
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });
            },
            planOutgoingMessage: (msg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
                retryTracking: {
                    enabled: true,
                    maxAttempts: 2,
                    retryDelayMs: 50,
                },
            }),
        });
        const msg = createOutboundMessage('msg-not-yet-in-sync');

        await enqueueOutboundOrThrow(runtime, msg);
        await runtime.acceptControlMessage(
            newALNackControlMessage(
                'server-1',
                'self',
                msg.id.msgId,
                'not-yet-in-sync',
                undefined,
                {
                    serverSnapshotVersion: 3,
                },
            ),
        );

        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' },
        ]);

        await vi.advanceTimersByTimeAsync(49);
        expect(sent).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(1);
        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' },
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' },
        ]);
        runtime.dispose();
    });

    it('can re-enter the outbox for a not-yet-in-sync retry when planning requires durability', async () => {
        vi.useFakeTimers();

        const outbox = new InMemoryQueueBox(new Map());
        const sent: Array<Record<string, unknown>> = [];
        let persistRetry = false;
        const runtime = createOutboundRuntime({
            outbox,
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });
                persistRetry = true;
            },
            planOutgoingMessage: (msg) => persistRetry
                ? {
                    persist: true,
                    preparedMessages: [],
                    retryTracking: {
                        enabled: true,
                        maxAttempts: 2,
                        retryDelayMs: 50,
                    },
                }
                : {
                    persist: false,
                    preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
                    retryTracking: {
                        enabled: true,
                        maxAttempts: 2,
                        retryDelayMs: 50,
                    },
                },
        });
        const msg = createOutboundMessage('msg-not-yet-in-sync-outbox');

        await enqueueOutboundOrThrow(runtime, msg);
        await runtime.acceptControlMessage(
            newALNackControlMessage('server-1', 'self', msg.id.msgId, 'not-yet-in-sync'),
        );
        await vi.advanceTimersByTimeAsync(50);

        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' },
        ]);
        const reserved = await outbox.reserveEntries(
            new Set(['outbox']),
            new Set([EntityStatus.NEW]),
            10,
        );
        expect(reserved.size).toBe(1);
        const stored = firstValue(reserved);
        const storedMsg = JSON.parse(stored.resource) as ALMessage;
        expect(storedMsg.id.msgId).toBe(msg.id.msgId);
        runtime.dispose();
    });

    it('coalesces duplicate not-yet-in-sync nacks while a retry is pending', async () => {
        vi.useFakeTimers();

        const sent: Array<Record<string, unknown>> = [];
        const runtime = createOutboundRuntime({
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });
            },
            planOutgoingMessage: (msg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
                retryTracking: {
                    enabled: true,
                    maxAttempts: 3,
                    retryDelayMs: 50,
                },
            }),
        });
        const msg = createOutboundMessage('msg-duplicate-not-yet-in-sync');

        await enqueueOutboundOrThrow(runtime, msg);
        await runtime.acceptControlMessage(
            newALNackControlMessage('server-1', 'self', msg.id.msgId, 'not-yet-in-sync'),
        );
        await runtime.acceptControlMessage(
            newALNackControlMessage('server-1', 'self', msg.id.msgId, 'not-yet-in-sync'),
        );
        await vi.advanceTimersByTimeAsync(50);

        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' },
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' },
        ]);
        runtime.dispose();
    });

    it('reuses the prior outbox key when supersedence replaces a persisted message', async () => {
        const outbox = new InMemoryQueueBox(new Map());
        const runtime = createOutboundRuntime({
            outbox,
            sendPreparedMessage: async () => Promise.resolve(),
            planOutgoingMessage: (msg) => ({
                persist: true,
                preparedMessages: [],
                supersedenceTracking: {
                    enabled: true,
                    algo: 'latest-wins',
                    key: `presence:${msg.route.contextId}`,
                },
            }),
        });

        const first = newALUnicastMessage(
            'self',
            {
                topicId: 'presence',
                resourceId: 'presence-1',
                contextId: 'room-1',
            },
            'peer-1',
            'presence.state.v1',
            {
                online: true,
            },
        );
        const second = newALUnicastMessage(
            'self',
            {
                topicId: 'presence',
                resourceId: 'presence-2',
                contextId: 'room-1',
            },
            'peer-1',
            'presence.state.v1',
            {
                online: false,
            },
        );

        const [firstEntry] = await enqueueOutboundOrThrow(runtime, first);
        const [secondEntry] = await enqueueOutboundOrThrow(runtime, second);

        expect(secondEntry.key).toEqual(firstEntry.key);

        const reserved = await outbox.reserveEntries(
            new Set(['outbox']),
            new Set([EntityStatus.NEW]),
            10,
        );

        expect(reserved.size).toBe(1);
        const stored = firstValue(reserved);
        const storedMsg = JSON.parse(stored.resource) as ALMessage;
        expect(storedMsg.id.msgId).toBe(second.id.msgId);
    });

    it('serializes concurrent supersedence enqueues through the versioned sender record', async () => {
        const outbox = new InMemoryQueueBox(new Map());
        const runtime = createOutboundRuntime({
            outbox,
            sendPreparedMessage: async () => Promise.resolve(),
            planOutgoingMessage: (msg) => ({
                persist: true,
                preparedMessages: [],
                supersedenceTracking: {
                    enabled: true,
                    algo: 'latest-wins',
                    key: `presence:${msg.id.senderId}:${msg.route.contextId}`,
                },
            }),
        });

        const first = {
            ...newALUnicastMessage(
                'self',
                {
                    topicId: 'presence',
                    resourceId: 'presence-1',
                    contextId: 'room-1',
                },
                'peer-1',
                'presence.state.v1',
                {
                    online: true,
                },
            ),
            ordering: {
                orderingKey: 'presence',
                epoch: 0,
                seq: 1,
            },
        };
        const second = {
            ...newALUnicastMessage(
                'self',
                {
                    topicId: 'presence',
                    resourceId: 'presence-2',
                    contextId: 'room-1',
                },
                'peer-1',
                'presence.state.v1',
                {
                    online: false,
                },
            ),
            ordering: {
                orderingKey: 'presence',
                epoch: 0,
                seq: 2,
            },
        };

        await Promise.all([
            enqueueOutboundOrThrow(runtime, first),
            enqueueOutboundOrThrow(runtime, second),
        ]);

        const reserved = await outbox.reserveEntries(
            new Set(['outbox']),
            new Set([EntityStatus.NEW]),
            10,
        );
        expect(reserved.size).toBe(1);
        const stored = firstValue(reserved);
        const storedMsg = JSON.parse(stored.resource) as ALMessage;
        expect(storedMsg.id.msgId).toBe(second.id.msgId);
    });

    it('does not miss acknowledgements that arrive while the send effect is running', async () => {
        vi.useFakeTimers();

        const sent: Array<Record<string, unknown>> = [];
        let runtime!: ALOutboundMessageRuntime<Record<string, unknown>>;
        const msg = createOutboundMessage('msg-ack-during-send');
        runtime = createOutboundRuntime({
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });
                await runtime.acceptControlMessage(
                    newALAckControlMessage('peer-1', 'self', msg.id.msgId),
                );
            },
            planOutgoingMessage: (plannedMsg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: plannedMsg.id.msgId }],
                ackTracking: {
                    enabled: true,
                    timeoutMs: 100,
                    maxAttempts: 1,
                    expectedPeerIds: ['peer-1'],
                },
                repairTracking: {
                    enabled: true,
                    algo: 'retransmit',
                    maxAttempts: 1,
                },
            }),
            planRepairMessage: async (plannedMsg, request) => ({
                persist: false,
                preparedMessages: [
                    {
                        kind: 'repair',
                        msgId: plannedMsg.id.msgId,
                        trigger: request.trigger,
                    },
                ],
            }),
        });

        await enqueueOutboundOrThrow(runtime, msg);
        await vi.advanceTimersByTimeAsync(200);

        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' },
        ]);
        runtime.dispose();
    });

    it('uses a stored acknowledgement accepted before outbound tracking is created', async () => {
        vi.useFakeTimers();

        const sent: Array<Record<string, unknown>> = [];
        const runtime = createOutboundRuntime({
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });
            },
            planOutgoingMessage: (msg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
                ackTracking: {
                    enabled: true,
                    timeoutMs: 100,
                    maxAttempts: 1,
                    expectedPeerIds: ['peer-1'],
                },
                repairTracking: {
                    enabled: true,
                    algo: 'retransmit',
                    maxAttempts: 1,
                },
            }),
            planRepairMessage: async (msg, request) => ({
                persist: false,
                preparedMessages: [{ kind: 'repair', msgId: msg.id.msgId, trigger: request.trigger }],
            }),
        });
        const msg = createOutboundMessage('msg-ack-before-send');

        await runtime.acceptControlMessage(
            newALAckControlMessage('peer-1', 'self', msg.id.msgId),
        );
        await enqueueOutboundOrThrow(runtime, msg);
        await vi.advanceTimersByTimeAsync(200);

        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' },
        ]);
        runtime.dispose();
    });

    it('does not resend successful prepared messages when a later prepared send fails', async () => {
        vi.useFakeTimers();

        const sent: string[] = [];
        let failPeer2 = true;
        const runtime = createOutboundRuntime({
            sendPreparedMessage: async (prepared) => {
                if (prepared.peerId === 'peer-2' && failPeer2) {
                    failPeer2 = false;
                    throw new Error('peer-2 unavailable');
                }

                sent.push(String(prepared.peerId));
            },
            planOutgoingMessage: () => ({
                persist: false,
                preparedMessages: [
                    { peerId: 'peer-1' },
                    { peerId: 'peer-2' },
                ],
            }),
        });

        await enqueueOutboundOrThrow(runtime, createOutboundMessage('msg-partial-send'));
        expect(sent).toEqual(['peer-1']);

        await vi.advanceTimersByTimeAsync(50);
        expect(sent).toEqual(['peer-1', 'peer-2']);
        runtime.dispose();
    });

    it('persists repair dispatches when the repair planner requests outbox durability', async () => {
        const outbox = new InMemoryQueueBox(new Map());
        const runtime = createOutboundRuntime({
            outbox,
            sendPreparedMessage: async () => Promise.resolve(),
            planOutgoingMessage: (msg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
                repairTracking: {
                    enabled: true,
                    algo: 'retransmit',
                    maxAttempts: 1,
                },
            }),
            planRepairMessage: async () => ({
                persist: true,
                preparedMessages: [],
            }),
        });
        const msg = createOutboundMessage('msg-persisted-repair');

        await enqueueOutboundOrThrow(runtime, msg);
        await runtime.acceptControlMessage(
            newALNackControlMessage('peer-1', 'self', msg.id.msgId, 'gap'),
        );

        const reserved = await outbox.reserveEntries(
            new Set(['outbox']),
            new Set([EntityStatus.NEW]),
            10,
        );
        expect(reserved.size).toBe(1);
        const stored = firstValue(reserved);
        const storedMsg = JSON.parse(stored.resource) as ALMessage;
        expect(storedMsg.id.msgId).toBe(msg.id.msgId);
    });

    it('drains committed send effects after a restart when the first runtime crashes before drain', async () => {
        const sent: Array<Record<string, unknown>> = [];
        const admissionStore = createMemoryOutboundAdmissionStore();
        const msg = createOutboundMessage('msg-crash-before-drain');
        const runtime1 = createOutboundRuntime({
            stores: {
                admissionStore: createFlakyOutboundAdmissionStore(admissionStore, {
                    claimReadyEffects: async () => [],
                }),
            },
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });
            },
            planOutgoingMessage: (plannedMsg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: plannedMsg.id.msgId }],
            }),
        });

        await enqueueOutboundOrThrow(runtime1, msg);
        runtime1.dispose();

        expect(sent).toEqual([]);

        const runtime2 = createOutboundRuntime({
            stores: {
                admissionStore,
            },
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });
            },
            planOutgoingMessage: (plannedMsg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: plannedMsg.id.msgId }],
            }),
        });

        await runtime2.ready();

        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' },
        ]);
        runtime2.dispose();
    });

    it('replays a sent effect when completion fails after transport send', async () => {
        vi.useFakeTimers();

        const sent: Array<Record<string, unknown>> = [];
        const admissionStore = createMemoryOutboundAdmissionStore();
        let failFirstComplete = true;
        const msg = createOutboundMessage('msg-complete-fails-after-send');
        const runtime = createOutboundRuntime({
            stores: {
                admissionStore: createFlakyOutboundAdmissionStore(admissionStore, {
                    completeEffect: async (effectId, workerId) => {
                        if (failFirstComplete) {
                            failFirstComplete = false;
                            throw new Error('complete failed after send');
                        }

                        await admissionStore.completeEffect(effectId, workerId);
                    },
                }),
            },
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });
            },
            planOutgoingMessage: (plannedMsg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: plannedMsg.id.msgId }],
            }),
        });

        await enqueueOutboundOrThrow(runtime, msg);
        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' },
        ]);

        await vi.advanceTimersByTimeAsync(49);
        expect(sent).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(1);
        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' },
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' },
        ]);
        runtime.dispose();
    });

    it('lets only one runtime claim the same committed send effect', async () => {
        const sent: Array<Record<string, unknown>> = [];
        const admissionStore = createMemoryOutboundAdmissionStore();
        const msg = createOutboundMessage('msg-single-claim');
        const runtime1 = createOutboundRuntime({
            stores: {
                admissionStore: createFlakyOutboundAdmissionStore(admissionStore, {
                    claimReadyEffects: async () => [],
                }),
            },
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });
            },
            planOutgoingMessage: (plannedMsg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: plannedMsg.id.msgId }],
            }),
        });

        await enqueueOutboundOrThrow(runtime1, msg);
        runtime1.dispose();
        expect(sent).toEqual([]);

        let releaseSend!: () => void;
        let resolveSendStarted!: () => void;
        const sendStarted = new Promise<void>(resolve => {
            resolveSendStarted = resolve;
        });
        const sendBarrier = new Promise<void>(resolve => {
            releaseSend = resolve;
        });
        const blockingSend: ConstructorParameters<
            typeof ALOutboundMessageRuntime<Record<string, unknown>>
        >[0]['sendPreparedMessage'] = async (prepared, phase) => {
            sent.push({ ...prepared, phase });
            resolveSendStarted();
            await sendBarrier;
        };
        const runtime2 = createOutboundRuntime({
            stores: {
                admissionStore,
            },
            sendPreparedMessage: blockingSend,
            planOutgoingMessage: (plannedMsg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: plannedMsg.id.msgId }],
            }),
        });
        const runtime3 = createOutboundRuntime({
            stores: {
                admissionStore,
            },
            sendPreparedMessage: blockingSend,
            planOutgoingMessage: (plannedMsg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: plannedMsg.id.msgId }],
            }),
        });
        const drain = Promise.all([runtime2.ready(), runtime3.ready()]);

        await sendStarted;
        await Promise.resolve();
        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' },
        ]);

        releaseSend();
        await drain;
        runtime2.dispose();
        runtime3.dispose();
    });

    it('does not repair when an acknowledgement is accepted while the timeout effect is claimed', async () => {
        vi.useFakeTimers();

        const sent: Array<Record<string, unknown>> = [];
        const admissionStore = createMemoryOutboundAdmissionStore();
        const msg = createOutboundMessage('msg-ack-during-timeout');
        let acceptedAckDuringTimeout = false;
        const runtime = createOutboundRuntime({
            stores: {
                admissionStore: createFlakyOutboundAdmissionStore(admissionStore, {
                    claimReadyEffects: async <TPrepared>(
                        workerId: string,
                        maxCount: number,
                        leaseMs: number,
                        nowMs?: number,
                    ) => {
                        const effects = await admissionStore.claimReadyEffects<TPrepared>(
                            workerId,
                            maxCount,
                            leaseMs,
                            nowMs,
                        );
                        if (
                            !acceptedAckDuringTimeout
                            && effects.some(effect => effect.payload.kind === 'ack-timeout')
                        ) {
                            acceptedAckDuringTimeout = true;
                            await admissionStore.acceptControlMessage(
                                newALAckControlMessage('peer-1', 'self', msg.id.msgId),
                            );
                        }

                        return effects;
                    },
                }),
            },
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });
            },
            planOutgoingMessage: (plannedMsg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: plannedMsg.id.msgId }],
                ackTracking: {
                    enabled: true,
                    timeoutMs: 100,
                    maxAttempts: 1,
                    expectedPeerIds: ['peer-1'],
                },
                repairTracking: {
                    enabled: true,
                    algo: 'retransmit',
                    maxAttempts: 1,
                },
            }),
            planRepairMessage: async (plannedMsg, request) => ({
                persist: false,
                preparedMessages: [
                    {
                        kind: 'repair',
                        msgId: plannedMsg.id.msgId,
                        trigger: request.trigger,
                    },
                ],
            }),
        });

        await enqueueOutboundOrThrow(runtime, msg);
        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' },
        ]);

        await vi.advanceTimersByTimeAsync(100);

        expect(acceptedAckDuringTimeout).toBe(true);
        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' },
        ]);
        runtime.dispose();
    });

    it('recomputes from the latest read after a commit conflict', async () => {
        vi.useFakeTimers();

        const sent: Array<Record<string, unknown>> = [];
        const admissionStore = createMemoryOutboundAdmissionStore();
        const msg = createOutboundMessage('msg-conflict-recompute');
        let rejectedFirstCommit = false;
        const runtime = createOutboundRuntime({
            stores: {
                admissionStore: createFlakyOutboundAdmissionStore(admissionStore, {
                    commitBundle: async <TPrepared>(bundle: ALOutboundCommitBundle<TPrepared>) => {
                        if (!rejectedFirstCommit) {
                            rejectedFirstCommit = true;
                            await admissionStore.acceptControlMessage(
                                newALAckControlMessage('peer-1', 'self', msg.id.msgId),
                            );
                            return 'conflict';
                        }

                        return await admissionStore.commitBundle(bundle);
                    },
                }),
            },
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });
            },
            planOutgoingMessage: (plannedMsg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: plannedMsg.id.msgId }],
                ackTracking: {
                    enabled: true,
                    timeoutMs: 100,
                    maxAttempts: 1,
                    expectedPeerIds: ['peer-1'],
                },
                repairTracking: {
                    enabled: true,
                    algo: 'retransmit',
                    maxAttempts: 1,
                },
            }),
            planRepairMessage: async (plannedMsg, request) => ({
                persist: false,
                preparedMessages: [
                    {
                        kind: 'repair',
                        msgId: plannedMsg.id.msgId,
                        trigger: request.trigger,
                    },
                ],
            }),
        });

        const conflictEnqueue = enqueueOutboundOrThrow(runtime, msg);
        await vi.advanceTimersByTimeAsync(10);
        await conflictEnqueue;
        await vi.advanceTimersByTimeAsync(200);

        expect(rejectedFirstCommit).toBe(true);
        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' },
        ]);
        runtime.dispose();
    });
});

async function enqueueOutboundOrThrow(
    runtime: Pick<ALOutboundMessageRuntime<Record<string, unknown>>, 'enqueueIfAbsent'>,
    msg: ALMessage,
): Promise<readonly ResourceEntry[]> {
    const enqueued = await runtime.enqueueIfAbsent(msg);
    if (enqueued.status === 'failed') {
        throw new Error(enqueued.reason);
    }

    return enqueued.entries;
}

async function reserveOutbox(outbox: InMemoryQueueBox): Promise<readonly ResourceEntry[]> {
    return [
        ...(
            await outbox.reserveEntries(
                new Set(['outbox']),
                new Set([EntityStatus.NEW]),
                10,
            )
        ).values(),
    ];
}

function createOutboundRuntime(options: {
    outbox?: InMemoryQueueBox;
    stores?: ConstructorParameters<
        typeof ALOutboundMessageRuntime<Record<string, unknown>>
    >[0]['stores'];
    planOutgoingMessage: (
        msg: ALMessage,
    ) => ReturnType<
        ConstructorParameters<
            typeof ALOutboundMessageRuntime<Record<string, unknown>>
        >[0]['planOutgoingMessage']
    >;
    planRepairMessage?: ConstructorParameters<
        typeof ALOutboundMessageRuntime<Record<string, unknown>>
    >[0]['planRepairMessage'];
    sendPreparedMessage: ConstructorParameters<
        typeof ALOutboundMessageRuntime<Record<string, unknown>>
    >[0]['sendPreparedMessage'];
}) {
    const outbox = options.outbox ?? new InMemoryQueueBox(new Map());

    return new ALOutboundMessageRuntime<Record<string, unknown>>({
        outbox,
        stores: options.stores,
        toOutboxEntry: (msg) =>
            QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox'),
        readMessageFromEntry: (entry) => JSON.parse(entry.resource) as ALMessage,
        planOutgoingMessage: options.planOutgoingMessage,
        planRepairMessage: options.planRepairMessage,
        sendPreparedMessage: options.sendPreparedMessage,
    });
}

function createMemoryOutboundAdmissionStore(): ALOutboundAdmissionStore {
    return createALOutboundAdmissionStore({
        kind: 'memory',
        namespace: `outbound-test:${crypto.randomUUID()}`,
        supersedenceTrackTtlMs: 5 * 60_000,
        state: createInMemoryALOutboundAdmissionState(),
    });
}

function createFlakyOutboundAdmissionStore(
    inner: ALOutboundAdmissionStore,
    hooks: Partial<Pick<
        ALOutboundAdmissionStore,
        'claimReadyEffects' | 'commitBundle' | 'completeEffect' | 'rescheduleEffect'
    >>,
): ALOutboundAdmissionStore {
    return {
        ready: () => inner.ready(),
        readOutgoingMessage: <TPrepared>(
            msg: ALMessage,
            planner: ALOutboundPlanner<TPrepared>,
        ) => inner.readOutgoingMessage<TPrepared>(msg, planner),
        readRepairMessage: <TPrepared>(
            msgId: string,
            planner: ALOutboundPlanner<TPrepared>,
        ) => inner.readRepairMessage<TPrepared>(msgId, planner),
        getSentMessage: (msgId: string) => inner.getSentMessage(msgId),
        getAllSentMessages: () => inner.getAllSentMessages(),
        getPendingAck: (msgId: string) => inner.getPendingAck(msgId),
        commitBundle: <TPrepared>(bundle: ALOutboundCommitBundle<TPrepared>) =>
            hooks.commitBundle
                ? hooks.commitBundle<TPrepared>(bundle)
                : inner.commitBundle<TPrepared>(bundle),
        acceptControlMessage: <TPrepared>(msg: ALMessage) =>
            inner.acceptControlMessage<TPrepared>(msg),
        claimReadyEffects: <TPrepared>(
            workerId: string,
            maxCount: number,
            leaseMs: number,
            nowMs?: number,
        ) => hooks.claimReadyEffects
            ? hooks.claimReadyEffects<TPrepared>(workerId, maxCount, leaseMs, nowMs)
            : inner.claimReadyEffects<TPrepared>(workerId, maxCount, leaseMs, nowMs),
        completeEffect: (effectId: string, workerId: string) =>
            hooks.completeEffect
                ? hooks.completeEffect(effectId, workerId)
                : inner.completeEffect(effectId, workerId),
        rescheduleEffect: (
            effectId: string,
            workerId: string,
            retryAtMs: number,
            lastError?: string,
        ) => hooks.rescheduleEffect
            ? hooks.rescheduleEffect(effectId, workerId, retryAtMs, lastError)
            : inner.rescheduleEffect(effectId, workerId, retryAtMs, lastError),
        peekNextEffectReadyAt: (nowMs?: number) => inner.peekNextEffectReadyAt(nowMs),
    };
}

function createOutboundMessage(resourceId: string) {
    return newALUnicastMessage(
        'self',
        {
            topicId: 'chat',
            resourceId,
            contextId: 'conversation-1',
        },
        'peer-1',
        'chat.private-text.v1',
        {
            text: resourceId,
        },
    );
}

function firstValue<K, V>(map: Map<K, V>): V {
    const first = map.values().next().value;
    if (first === undefined) {
        throw new Error('Expected at least one map value');
    }
    return first;
}
