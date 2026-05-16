// @vitest-environment happy-dom

import '../setup-browser-indexeddb.ts';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    type ALInboundAdmissionStore,
    ALInboundMessageRuntime,
    type ALInboundPlanner,
    type ALMessage,
    type ALOutboundAdmissionStore,
    type ALOutboundCommitBundle,
    ALOutboundMessageRuntime,
    type ALOutboundPlanner,
    createIndexedDbALInboundRuntimeStores,
    createIndexedDbALOutboundRuntimeStores,
    IndexedDbQueueBox,
    InMemoryALOrderingStore,
    InMemoryQueueBox,
    newALAckControlMessage,
    newALMulticastMessage,
    newALNackControlMessage,
    newALUnicastMessage,
    planALMessageHandling,
    QueueBoxUtilities,
    type ResourceEntry,
} from '@shared/mod.ts';

describe('IndexedDB AL runtime stores', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('keeps inbound dedup state across runtime instances', async () => {
        const dbName = `al-runtime-${crypto.randomUUID()}`;
        const namespace = 'ws-client';
        const dispatchedMsgIds: string[] = [];
        const msg = newALUnicastMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: 'msg-1',
                contextId: 'conversation-1',
            },
            'self',
            'chat.private-text.v1',
            {
                text: 'hello',
            },
            {
                qos: {
                    durability: {
                        algo: 'volatile',
                    },
                },
            },
        );

        const runtime1 = createInboundRuntime(dbName, namespace, dispatchedMsgIds);
        await runtime1.handleIncomingMessage(msg, 'peer-1');
        expect(dispatchedMsgIds).toEqual([msg.id.msgId]);

        const runtime2 = createInboundRuntime(dbName, namespace, dispatchedMsgIds);
        await runtime2.handleIncomingMessage(msg, 'peer-1');
        expect(dispatchedMsgIds).toEqual([msg.id.msgId]);
    });

    it('releases buffered ordered messages after restart', async () => {
        const dbName = `al-runtime-${crypto.randomUUID()}`;
        const namespace = 'rtc-inbound';
        const dispatchedMsgIds: string[] = [];
        const runtime1 = createInboundRuntime(dbName, namespace, dispatchedMsgIds);
        const seq2 = createOrderedMulticastMessage(2, 'two');
        const seq1 = createOrderedMulticastMessage(1, 'one');

        await runtime1.handleIncomingMessage(seq2, 'peer-1');
        expect(dispatchedMsgIds).toEqual([]);

        const runtime2 = createInboundRuntime(dbName, namespace, dispatchedMsgIds);
        await runtime2.handleIncomingMessage(seq1, 'peer-1');

        expect(dispatchedMsgIds).toEqual([seq1.id.msgId, seq2.id.msgId]);
    });

    it('supports sharing one IndexedDB database between admission state and inbox queue stores', async () => {
        const dbName = `al-runtime-${crypto.randomUUID()}`;
        const namespace = 'shared-browser-db';
        const inbox = new IndexedDbQueueBox({
            dbName,
            storeName: 'queuebox:inbox',
        });
        const dispatchedMsgIds: string[] = [];
        const runtime = new ALInboundMessageRuntime({
            selfPeerId: 'self',
            inbox,
            stores: createIndexedDbALInboundRuntimeStores({
                dbName,
                namespace,
            }),
            planIncomingMessage: (msg, fromPeerId, runtime) =>
                planALMessageHandling(msg, {
                    selfPeerId: 'self',
                    fromPeerId,
                    dedupStore: runtime.dedupStore,
                    orderingStore: runtime.orderingStore,
                    supersedenceStore: runtime.supersedenceStore,
                }),
            readStoredEntry: (entry) => JSON.parse(entry.resource) as ALMessage,
            toInboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'inbox'),
            dispatchInboxEntry: async (entry) => {
                const msg = JSON.parse(entry.resource) as ALMessage;
                dispatchedMsgIds.push(msg.id.msgId);
            },
            sendControlMessage: async () => Promise.resolve(),
        });
        const msg = newALUnicastMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: 'msg-shared-db',
                contextId: 'conversation-1',
            },
            'self',
            'chat.private-text.v1',
            {
                text: 'persist me',
            },
        );

        await inbox.getAllKeys();
        await runtime.ready();
        await runtime.handleIncomingMessage(msg, 'peer-1');

        expect(dispatchedMsgIds).toEqual([msg.id.msgId]);
        expect(await inbox.getAllKeys()).toEqual([]);
    });

    it('persists inbound local-inbox effects without leaking Temporal values into IndexedDB', async () => {
        const dbName = `al-runtime-${crypto.randomUUID()}`;
        const namespace = 'rtc-inbound-local-inbox';
        const stores = createIndexedDbALInboundRuntimeStores({
            dbName,
            namespace,
        });
        const runtime = createInboundRuntime(dbName, namespace, [], {
            stores: {
                ...stores,
                admissionStore: createFlakyInboundAdmissionStore(stores.admissionStore, {
                    claimReadyEffects: async () => [],
                }),
            },
        });
        const msg = newALUnicastMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: 'msg-local-inbox',
                contextId: 'conversation-1',
            },
            'self',
            'chat.private-text.v1',
            {
                text: 'persist me later',
            },
            {
                qos: {
                    durability: {
                        algo: 'local-inbox',
                    },
                },
            },
        );

        await runtime.handleIncomingMessage(msg, 'peer-1');
        runtime.dispose();

        const claimed = await stores.admissionStore.claimReadyEffects('inspector', 10, 1_000);
        const inboxEffect = claimed.find(effect => effect.payload.kind === 'enqueue-inbox');

        expect(inboxEffect).toBeDefined();
        expect(inboxEffect?.payload.kind).toBe('enqueue-inbox');
        if (!inboxEffect || inboxEffect.payload.kind !== 'enqueue-inbox') {
            throw new Error('Expected an enqueue-inbox effect');
        }

        expect(JSON.parse(inboxEffect.payload.entry.resource)).toMatchObject({
            id: {
                msgId: msg.id.msgId,
            },
        });
        expect(typeof inboxEffect.payload.entry.audit.date).toBe('object');
        expect(typeof inboxEffect.payload.entry.audit.createdTs).toBe('object');
        expect(typeof inboxEffect.payload.entry.audit.expiryTs).toBe('object');
    });

    it('expires inbound control history and owner versions with configured retention', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const dbName = `al-runtime-${crypto.randomUUID()}`;
        const namespace = 'rtc-inbound-retention';
        const stores = createIndexedDbALInboundRuntimeStores({
            dbName,
            namespace,
            retention: {
                controlHistoryTtlMs: 20,
                msgOwnerTtlMs: 20,
                versionTtlMs: 20,
            },
        });
        const msg = newALUnicastMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: 'msg-inbound-retention',
                contextId: 'conversation-1',
            },
            'self',
            'chat.private-text.v1',
            {
                text: 'retained briefly',
            },
        );
        const planner = createInboundPlanner();

        expect(await stores.admissionStore.commitMutations({
            senderId: msg.id.senderId,
            expectedVersion: undefined,
            mutations: [
                {
                    kind: 'set-msg-owner',
                    msgId: msg.id.msgId,
                    senderId: msg.id.senderId,
                },
            ],
        })).toBe('committed');

        await stores.admissionStore.acceptControlMessage(
            newALAckControlMessage('peer-2', 'self', msg.id.msgId),
        );

        const beforeExpiry = await stores.admissionStore.readIncomingMessage(
            msg,
            'peer-1',
            planner,
        );
        expect(beforeExpiry.clientRecord?.version).toBe(2);
        expect(beforeExpiry.acks).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(21);

        await stores.admissionStore.acceptControlMessage(
            newALAckControlMessage('peer-3', 'self', msg.id.msgId),
        );

        const afterExpiry = await stores.admissionStore.readIncomingMessage(
            msg,
            'peer-1',
            planner,
        );
        expect(afterExpiry.clientRecord).toBeUndefined();
        expect(afterExpiry.acks).toHaveLength(1);
        expect(afterExpiry.acks[0]?.fromPeerId).toBe('peer-3');
    });

    it('expires outbound sent snapshots without explicit message expiry using repository defaults', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const dbName = `al-runtime-${crypto.randomUUID()}`;
        const namespace = 'rtc-outbound-retention-defaults';
        const sent: Array<Record<string, unknown>> = [];
        const stores = createIndexedDbALOutboundRuntimeStores({
            dbName,
            namespace,
        });
        const admissionStore = requireOutboundAdmissionStore(stores);
        const runtime = createOutboundRuntime(dbName, namespace, sent, {
            stores,
        });
        const msg = createOutboundUnicastMessage('msg-outbound-default-retention');

        await enqueueOutboundOrThrow(runtime, msg);
        expect(await admissionStore.getSentMessage(msg.id.msgId)).toBeDefined();

        await vi.advanceTimersByTimeAsync(60 * 60_000 + 1);

        expect(await admissionStore.getSentMessage(msg.id.msgId)).toBeUndefined();
        runtime.dispose();
    });

    it('expires outbound repair attempts and control history with configured retention', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const dbName = `al-runtime-${crypto.randomUUID()}`;
        const namespace = 'rtc-outbound-retention-ephemeral';
        const stores = createIndexedDbALOutboundRuntimeStores({
            dbName,
            namespace,
            retention: {
                controlHistoryTtlMs: 20,
                repairAttemptTtlMs: 20,
                repositoryTtlMs: 60_000,
            },
        });
        const admissionStore = requireOutboundAdmissionStore(stores);
        const msg = createOutboundUnicastMessage('msg-outbound-ephemeral-retention');
        const planner = createOutboundPlanner();

        expect(await admissionStore.commitBundle({
            senderId: msg.id.senderId,
            expectedVersion: undefined,
            mutations: [
                {
                    kind: 'set-msg-owner',
                    msgId: msg.id.msgId,
                    senderId: msg.id.senderId,
                },
                {
                    kind: 'set-sent-message',
                    snapshot: {
                        msgId: msg.id.msgId,
                        msg,
                    },
                },
                {
                    kind: 'set-repair-attempt',
                    snapshot: {
                        msgId: msg.id.msgId,
                        attempts: 1,
                    },
                },
            ],
            durableEffects: [],
        })).toBe('committed');

        await admissionStore.acceptControlMessage(
            newALNackControlMessage('peer-1', 'self', msg.id.msgId, 'gap'),
        );

        const beforeExpiry = await admissionStore.readOutgoingMessage(msg, planner);
        expect(beforeExpiry.sentSnapshot).toBeDefined();
        expect(beforeExpiry.repairAttempt?.attempts).toBe(1);
        expect(beforeExpiry.nacks).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(21);

        const afterExpiry = await admissionStore.readOutgoingMessage(msg, planner);
        expect(afterExpiry.sentSnapshot).toBeDefined();
        expect(afterExpiry.repairAttempt).toBeUndefined();
        expect(afterExpiry.nacks).toEqual([]);
    });

    it('retransmits cached ordered outbound messages after restart', async () => {
        const dbName = `al-runtime-${crypto.randomUUID()}`;
        const namespace = 'rtc-outbound';
        const sent: Array<Record<string, unknown>> = [];
        const runtime1 = createOutboundRuntime(dbName, namespace, sent);
        const seq1 = {
            ...newALUnicastMessage(
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
            ...newALUnicastMessage(
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

        await enqueueOutboundOrThrow(runtime1, seq1);
        await enqueueOutboundOrThrow(runtime1, seq2);

        const runtime2 = createOutboundRuntime(dbName, namespace, sent);
        await runtime2.acceptControlMessage(
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

        expect(sent.filter((entry) => entry.msgId === seq1.id.msgId)).toHaveLength(2);
    });

    it('drains committed outbound effects from IndexedDB after restart', async () => {
        const dbName = `al-runtime-${crypto.randomUUID()}`;
        const namespace = 'rtc-outbound-crash-before-drain';
        const sent: Array<Record<string, unknown>> = [];
        const stores = createIndexedDbALOutboundRuntimeStores({
            dbName,
            namespace,
        });
        const admissionStore = requireOutboundAdmissionStore(stores);
        const msg = createOutboundUnicastMessage('msg-indexeddb-crash-before-drain');
        const runtime1 = createOutboundRuntime(dbName, namespace, sent, {
            stores: {
                ...stores,
                admissionStore: createFlakyOutboundAdmissionStore(admissionStore, {
                    claimReadyEffects: async () => [],
                }),
            },
        });

        await enqueueOutboundOrThrow(runtime1, msg);
        runtime1.dispose();
        expect(sent).toEqual([]);

        const runtime2 = createOutboundRuntime(dbName, namespace, sent);
        await runtime2.ready();

        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' },
        ]);
        runtime2.dispose();
    });

    it('lets only one runtime claim the same IndexedDB outbound effect', async () => {
        const dbName = `al-runtime-${crypto.randomUUID()}`;
        const namespace = 'rtc-outbound-single-claim';
        const sent: Array<Record<string, unknown>> = [];
        const stores = createIndexedDbALOutboundRuntimeStores({
            dbName,
            namespace,
        });
        const admissionStore = requireOutboundAdmissionStore(stores);
        const msg = createOutboundUnicastMessage('msg-indexeddb-single-claim');
        const runtime1 = createOutboundRuntime(dbName, namespace, sent, {
            stores: {
                ...stores,
                admissionStore: createFlakyOutboundAdmissionStore(admissionStore, {
                    claimReadyEffects: async () => [],
                }),
            },
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
        const sendPreparedMessage: ConstructorParameters<
            typeof ALOutboundMessageRuntime<Record<string, unknown>>
        >[0]['sendPreparedMessage'] = async (prepared, phase) => {
            sent.push({ ...prepared, phase });
            resolveSendStarted();
            await sendBarrier;
        };
        const runtime2 = createOutboundRuntime(dbName, namespace, sent, {
            sendPreparedMessage,
        });
        const runtime3 = createOutboundRuntime(dbName, namespace, sent, {
            sendPreparedMessage,
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

    it('does not repair from IndexedDB when an acknowledgement is accepted while timeout is claimed', async () => {
        const dbName = `al-runtime-${crypto.randomUUID()}`;
        const namespace = 'rtc-outbound-ack-timeout-race';
        const sent: Array<Record<string, unknown>> = [];
        const stores = createIndexedDbALOutboundRuntimeStores({
            dbName,
            namespace,
        });
        const admissionStore = requireOutboundAdmissionStore(stores);
        const msg = createOutboundUnicastMessage('msg-indexeddb-ack-during-timeout');
        let acceptedAckDuringTimeout = false;
        const runtime = createOutboundRuntime(dbName, namespace, sent, {
            stores: {
                ...stores,
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
            planOutgoingMessage: plannedMsg => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: plannedMsg.id.msgId }],
                ackTracking: {
                    enabled: true,
                    timeoutMs: 10,
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

        await new Promise<void>(resolve => setTimeout(resolve, 30));

        expect(acceptedAckDuringTimeout).toBe(true);
        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' },
        ]);
        runtime.dispose();
    });

    it('expires persisted outbound state snapshots with configured retention', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const dbName = `al-runtime-${crypto.randomUUID()}`;
        const namespace = 'rtc-outbound-state-retention';
        const stores = createIndexedDbALOutboundRuntimeStores({
            dbName,
            namespace,
            retention: {
                sentMessageTtlMs: 40,
                repairAttemptTtlMs: 20,
            },
        });
        const stateStore = requireOutboundStateStore(stores);
        const msg = createOutboundUnicastMessage('msg-state-retention');

        await stateStore.setSentMessage({
            msgId: msg.id.msgId,
            msg,
        });
        await stateStore.setRepairAttempt({
            msgId: msg.id.msgId,
            attempts: 1,
        });

        expect(await stateStore.getAllSentMessages()).toHaveLength(1);
        expect(await stateStore.getAllRepairAttempts()).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(21);

        expect(await stateStore.getAllRepairAttempts()).toEqual([]);
        expect(await stateStore.getAllSentMessages()).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(20);

        expect(await stateStore.getAllSentMessages()).toEqual([]);
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

function createInboundRuntime(
    dbName: string,
    namespace: string,
    dispatchedMsgIds: string[],
    options: Readonly<{
        stores?: ConstructorParameters<typeof ALInboundMessageRuntime>[0]['stores'];
    }> = {},
) {
    return new ALInboundMessageRuntime({
        selfPeerId: 'self',
        inbox: new InMemoryQueueBox(new Map()),
        stores: options.stores ?? createIndexedDbALInboundRuntimeStores({
            dbName,
            namespace,
        }),
        planIncomingMessage: (msg, fromPeerId, runtime) =>
            planALMessageHandling(msg, {
                selfPeerId: 'self',
                fromPeerId,
                dedupStore: runtime.dedupStore,
                orderingStore: runtime.orderingStore,
                supersedenceStore: runtime.supersedenceStore,
            }),
        readStoredEntry: (entry) => JSON.parse(entry.resource) as ALMessage,
        toInboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'inbox'),
        dispatchInboxEntry: async (entry: ResourceEntry) => {
            const msg = JSON.parse(entry.resource) as ALMessage;
            dispatchedMsgIds.push(msg.id.msgId);
        },
        sendControlMessage: async () => Promise.resolve(),
    });
}

function createInboundPlanner(): ALInboundPlanner {
    return (msg, fromPeerId, runtime) => planALMessageHandling(msg, {
        selfPeerId: 'self',
        fromPeerId,
        dedupStore: runtime.dedupStore,
        orderingStore: runtime.orderingStore,
        supersedenceStore: runtime.supersedenceStore,
    });
}

function createFlakyInboundAdmissionStore(
    inner: ALInboundAdmissionStore,
    hooks: Partial<Pick<
        ALInboundAdmissionStore,
        'claimReadyEffects' | 'commitBundle' | 'commitMutations'
    >>,
): ALInboundAdmissionStore {
    return {
        ready: () => inner.ready(),
        readIncomingMessage: (msg, fromPeerId, planner) =>
            inner.readIncomingMessage(msg, fromPeerId, planner),
        readBufferedRelease: (trackKey, seq) =>
            inner.readBufferedRelease(trackKey, seq),
        planStoredEntry: (msg, planner) =>
            inner.planStoredEntry(msg, planner),
        commitMutations: (request) => hooks.commitMutations
            ? hooks.commitMutations(request)
            : inner.commitMutations(request),
        commitBundle: (bundle) => hooks.commitBundle
            ? hooks.commitBundle(bundle)
            : inner.commitBundle(bundle),
        claimReadyEffects: (workerId, maxCount, leaseMs, nowMs) => hooks.claimReadyEffects
            ? hooks.claimReadyEffects(workerId, maxCount, leaseMs, nowMs)
            : inner.claimReadyEffects(workerId, maxCount, leaseMs, nowMs),
        completeEffect: (effectId, workerId) =>
            inner.completeEffect(effectId, workerId),
        rescheduleEffect: (effectId, workerId, retryAtMs, lastError) =>
            inner.rescheduleEffect(effectId, workerId, retryAtMs, lastError),
        peekNextEffectReadyAt: (nowMs) => inner.peekNextEffectReadyAt(nowMs),
        acceptControlMessage: (msg) => inner.acceptControlMessage(msg),
    };
}

function createOutboundRuntime(
    dbName: string,
    namespace: string,
    sent: Array<Record<string, unknown>>,
    options: Readonly<{
        stores?: ConstructorParameters<
            typeof ALOutboundMessageRuntime<Record<string, unknown>>
        >[0]['stores'];
        planOutgoingMessage?: ConstructorParameters<
            typeof ALOutboundMessageRuntime<Record<string, unknown>>
        >[0]['planOutgoingMessage'];
        planRepairMessage?: ConstructorParameters<
            typeof ALOutboundMessageRuntime<Record<string, unknown>>
        >[0]['planRepairMessage'];
        sendPreparedMessage?: ConstructorParameters<
            typeof ALOutboundMessageRuntime<Record<string, unknown>>
        >[0]['sendPreparedMessage'];
    }> = {},
) {
    return new ALOutboundMessageRuntime<Record<string, unknown>>({
        outbox: new InMemoryQueueBox(new Map()),
        stores: options.stores ?? createIndexedDbALOutboundRuntimeStores({
            dbName,
            namespace,
        }),
        toOutboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox'),
        readMessageFromEntry: (entry) => JSON.parse(entry.resource) as ALMessage,
        planOutgoingMessage: options.planOutgoingMessage ?? ((msg) => ({
            persist: false,
            preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
            repairTracking: {
                enabled: true,
                algo: 'retransmit',
                maxAttempts: 1,
            },
        })),
        planRepairMessage: options.planRepairMessage ?? (async (msg, request) => ({
            persist: false,
            preparedMessages: [
                {
                    kind: 'repair',
                    msgId: msg.id.msgId,
                    trigger: request.trigger,
                },
            ],
        })),
        sendPreparedMessage: options.sendPreparedMessage ?? (async (prepared, phase) => {
            sent.push({ ...prepared, phase });
        }),
    });
}

function createOutboundPlanner(): ALOutboundPlanner<Record<string, unknown>> {
    return (msg) => ({
        persist: false,
        preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
        repairTracking: {
            enabled: true,
            algo: 'retransmit',
            maxAttempts: 1,
        },
    });
}

function requireOutboundAdmissionStore(
    stores: ConstructorParameters<
        typeof ALOutboundMessageRuntime<Record<string, unknown>>
    >[0]['stores'],
): ALOutboundAdmissionStore {
    const admissionStore = stores?.admissionStore;
    if (!admissionStore) {
        throw new Error('Expected outbound admission store');
    }

    return admissionStore;
}

function requireOutboundStateStore(
    stores: ConstructorParameters<
        typeof ALOutboundMessageRuntime<Record<string, unknown>>
    >[0]['stores'],
) {
    const stateStore = stores?.stateStore;
    if (!stateStore) {
        throw new Error('Expected outbound state store');
    }

    return stateStore;
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
        commitBundle: <TPrepared>(bundle: ALOutboundCommitBundle<TPrepared>) => hooks.commitBundle
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
        completeEffect: (effectId: string, workerId: string) => hooks.completeEffect
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

function createOutboundUnicastMessage(resourceId: string) {
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

function createOrderedMulticastMessage(seq: number, text: string) {
    return newALMulticastMessage(
        'peer-1',
        {
            topicId: 'chat',
            resourceId: `msg-${seq}`,
            contextId: 'group-1',
        },
        'group-1',
        'chat.message.v1',
        {
            text,
        },
        {
            seq,
            reliability: 'at-least-once',
            ack: 'none',
            qos: {
                durability: {
                    algo: 'volatile',
                },
            },
        },
    );
}
