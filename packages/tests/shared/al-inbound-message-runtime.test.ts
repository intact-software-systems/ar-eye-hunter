import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { PersistenceProviderAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { ALAdmissionBackendConflictError } from '@shared/alm/ALAdmissionBackendConflictError.ts';
import { createDefaultALInboundMessageRuntime } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    ALAdmissionCorruptionError,
    createALInboundAdmissionStore,
    createDefaultInMemoryALInboundRuntimeStores,
    InMemoryPersistenceProvider,
    InMemoryQueueBox,
    newALAckControlMessage,
    newALMulticastMessage,
    normalizeALRuntimeStoreRetention,
    parseALControlMessage,
    planALMessageHandling,
    QueueBoxUtilities,
    type ALControlAcceptance,
    type ALInboundMessageRuntime,
    type ALInboundRuntimeStores,
    type ALMessage,
    type ALMessageHandlingPlan,
    type ResourceEntry
} from '@shared/mod.ts';

describe('ALInboundMessageRuntime', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('buffers ordered gaps, emits negative controls, and releases buffered messages in order', async () => {
        const { runtime, dispatchedTexts, controlMessages, forwardedIds } = createInboundHarness();

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
                reliability: 'at-least-once',
                ack: 'none',
                qos: {
                    durability: {
                        algo: 'volatile'
                    }
                }
            }
        );
        const seq1 = newALMulticastMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: 'msg-1',
                contextId: 'group-1'
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'one'
            },
            {
                seq: 1,
                reliability: 'at-least-once',
                ack: 'none',
                qos: {
                    durability: {
                        algo: 'volatile'
                    }
                }
            }
        );

        await runtime.handleIncomingMessage(seq2, { kind: 'ws-client', peerId: 'peer-1' });

        expect(dispatchedTexts).toEqual([]);
        expect(controlMessages.map((msg) => msg.payload.typeId)).toEqual([
            'al.control.nack.v1',
            'al.control.repair.v1'
        ]);

        await runtime.handleIncomingMessage(seq1, { kind: 'ws-client', peerId: 'peer-1' });

        expect(dispatchedTexts).toEqual(['one', 'two']);
        expect(forwardedIds).toEqual([seq2.id.msgId, seq1.id.msgId]);
    });

    // The transport capability is reconciled at admission (not at the
    // forward executor): a disowned message records no forward effect and
    // its subtree ack collapses to an immediate delivered ack — never a
    // deferred ack that waits on a subtree that will not exist.
    it('acks delivered without forwarding when the transport disowns a message', async () => {
        const { runtime, controlMessages, forwardedIds, dispatchedTexts } = createInboundHarness(
            undefined,
            { canForwardMessage: () => false }
        );
        const msg = createOrderedMessage(1, 'kept-local', 'all-logical-recipients');

        await runtime.handleIncomingMessage(msg, { kind: 'ws-client', peerId: 'peer-1' });

        expect(forwardedIds).toEqual([]);
        expect(dispatchedTexts).toEqual(['kept-local']);
        const ackPayloads = readAckPayloads(controlMessages);
        expect(ackPayloads).toHaveLength(1);
        expect(ackPayloads[0]).toMatchObject({
            ackedMsgId: msg.id.msgId,
            toPeerId: 'peer-1',
            status: 'delivered'
        });
    });

    it('returns a stale optimistic write to the caller and admits a fresh redelivery', async () => {
        vi.useFakeTimers();

        const stores = createDefaultInMemoryALInboundRuntimeStores();
        const baseAdmission = stores.admissionStore;
        const commitBundle = baseAdmission.commitBundle.bind(baseAdmission);
        let rejectedFirstCommit = false;
        vi.spyOn(baseAdmission, 'commitBundle').mockImplementation(async (bundle) => {
            if (!rejectedFirstCommit && bundle.senderId === 'peer-1') {
                rejectedFirstCommit = true;
                await commitBundle({
                    senderId: 'peer-1',
                    expectedVersion: bundle.expectedVersion,
                    versionExpireAtTimestamp: bundle.versionExpireAtTimestamp,
                    mutations: [{
                        kind: 'set-msg-owner',
                        msgId: 'external-version-bump',
                        senderId: 'peer-1',
                        source: { kind: 'ws-client', peerId: 'peer-1' },
                        supersedenceKey: null,
                        expireAtTimestamp: bundle.versionExpireAtTimestamp
                    }],
                    durableEffects: []
                });
            }
            return await commitBundle(bundle);
        });

        const { runtime, dispatchedTexts, forwardedIds } = createInboundHarness(stores);
        const seq2 = createOrderedMessage(2, 'two');
        const seq1 = createOrderedMessage(1, 'one');

        const rejected = await runtime.handleIncomingMessage(seq2, { kind: 'ws-client', peerId: 'peer-1' });
        expect(rejected.right).toEqual({ kind: 'not-admitted', reason: 'conflict' });
        expect(dispatchedTexts).toEqual([]);
        expect(forwardedIds).toEqual([]);
        await runtime.handleIncomingMessage(seq2, { kind: 'ws-client', peerId: 'peer-1' });
        await runtime.handleIncomingMessage(seq1, { kind: 'ws-client', peerId: 'peer-1' });

        expect(rejectedFirstCommit).toBe(true);
        expect(dispatchedTexts).toEqual(['one', 'two']);
        expect(forwardedIds).toEqual([seq2.id.msgId, seq1.id.msgId]);
    });

    it('preserves persisted corruption discovered during normal inbound admission', async () => {
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        const corruption = new ALAdmissionCorruptionError(
            'inbound:client:peer-1',
            new TypeError('invalid client admission state')
        );
        vi.spyOn(stores.admissionStore, 'readIncomingMessage').mockRejectedValue(corruption);
        const { runtime } = createInboundHarness(stores);

        await expect(runtime.handleIncomingMessage(
            createOrderedMessage(1, 'one'),
            { kind: 'ws-client', peerId: 'peer-1' }
        ))
            .rejects.toBe(corruption);
    });

    it('delivers the same message id once for each sender when sender-scoped dedup is requested', async () => {
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        const firstDeliveryStarted = Promise.withResolvers<void>();
        const releaseFirstDelivery = Promise.withResolvers<void>();
        const secondAdmissionCommitted = Promise.withResolvers<void>();
        const deliveredSenderIds: string[] = [];
        const commitBundle = stores.admissionStore.commitBundle.bind(stores.admissionStore);
        vi.spyOn(stores.admissionStore, 'commitBundle').mockImplementation(async (bundle) => {
            const status = await commitBundle(bundle);
            if (bundle.senderId === 'peer-2') {
                secondAdmissionCommitted.resolve();
            }
            return status;
        });
        const { runtime } = createInboundHarness(stores, {
            dispatchInboxEntry: async (entry) => {
                const message = decodePersistedALMessage(entry.resource);
                deliveredSenderIds.push(message.id.senderId);
                if (message.id.senderId === 'peer-1') {
                    firstDeliveryStarted.resolve();
                    await releaseFirstDelivery.promise;
                }
            }
        });
        const first = createSenderScopedDedupMessage('peer-1', 'first');
        const secondOriginal = createSenderScopedDedupMessage('peer-2', 'second');
        const second = {
            ...secondOriginal,
            id: {
                ...secondOriginal.id,
                msgId: first.id.msgId
            }
        };

        const firstAdmission = runtime.handleIncomingMessage(first, { kind: 'ws-client', peerId: 'peer-1' });
        await firstDeliveryStarted.promise;
        const secondAdmission = runtime.handleIncomingMessage(second, { kind: 'ws-client', peerId: 'peer-2' });
        await secondAdmissionCommitted.promise;
        releaseFirstDelivery.resolve();
        await Promise.all([firstAdmission, secondAdmission]);

        expect(deliveredSenderIds).toEqual(['peer-1', 'peer-2']);
    });

    it('returns control conflicts without an inner retry and accepts a later redelivery', async () => {
        vi.useFakeTimers();
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        const expireAtTimestamp = Date.now() + 300000;
        await stores.admissionStore.commitMutations({
            senderId: 'peer-1',
            versionExpireAtTimestamp: expireAtTimestamp,
            mutations: [{
                kind: 'set-msg-owner',
                msgId: 'missing-msg',
                senderId: 'peer-1',
                source: { kind: 'ws-client', peerId: 'peer-1' },
                supersedenceKey: null,
                expireAtTimestamp
            }, {
                kind: 'set-control-pending',
                msgId: 'missing-msg',
                senderId: 'peer-1',
                expireAtTimestamp,
                value: {
                    kind: 'pending',
                    value: {
                        toPeerId: 'peer-1',
                        status: 'subtree-complete',
                        localReady: false,
                        expectedFromPeerIds: ['peer-2'],
                        ackedFromPeerIds: []
                    }
                }
            }, {
                kind: 'set-control-owners',
                msgId: 'missing-msg',
                expected: undefined,
                value: { ambiguous: false, values: [{ peerId: 'peer-2', senderId: 'peer-1' }] },
                expireAtTimestamp
            }]
        });
        const acceptControlMessage = stores.admissionStore.acceptControlMessage.bind(stores.admissionStore);
        let attempts = 0;
        vi.spyOn(stores.admissionStore, 'acceptControlMessage').mockImplementation(async (msg) => {
            attempts += 1;
            if (attempts < 4) {
                throw new ALAdmissionBackendConflictError('simulated inbound control conflict');
            }
            return await acceptControlMessage(msg);
        });
        const { runtime, controlAcceptances } = createInboundHarness(stores);

        const control = newALAckControlMessage(
            { v: 2, msgId: 'control-missing-ack', ts: 1, senderId: 'peer-2' },
            {
                ackedMsgId: 'missing-msg',
                fromPeerId: 'peer-2',
                toPeerId: 'self',
                status: 'delivered',
                observedAtEpochMs: 1
            }
        );
        for (let delivery = 1; delivery <= 3; delivery++) {
            const result = await runtime.handleIncomingMessage(control, { kind: 'ws-client', peerId: 'peer-2' });
            expect(result.right).toEqual({ kind: 'not-admitted', reason: 'conflict' });
            expect(attempts).toBe(delivery);
            expect(controlAcceptances).toEqual([]);
        }
        const accepted = await runtime.handleIncomingMessage(control, { kind: 'ws-client', peerId: 'peer-2' });
        expect(accepted.right).toEqual({ kind: 'control', handled: true });
        expect(attempts).toBe(4);
        expect(controlAcceptances).toHaveLength(1);
    });

    it('redelivers buffered work when a downstream ack updates the sender version', async () => {
        vi.useFakeTimers();
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        const baseAdmission = stores.admissionStore;
        const commitBundle = baseAdmission.commitBundle.bind(baseAdmission);
        const releaseCommitBlocked = Promise.withResolvers<void>();
        const releaseCommitReady = Promise.withResolvers<void>();
        const seq2 = createOrderedMessage(2, 'two', 'all-logical-recipients');
        const seq1 = createOrderedMessage(1, 'one');
        let didBlock = false;
        let releaseConflictObserved = false;

        vi.spyOn(baseAdmission, 'commitBundle').mockImplementation(async (bundle) => {
            const releasesSecondMessage = bundle.durableEffects.some(({ payload }) =>
                (payload.kind === 'dispatch-local' || payload.kind === 'enqueue-inbox') &&
                decodePersistedALMessage(payload.entry.resource).id.msgId === seq2.id.msgId
            );
            if (!didBlock && releasesSecondMessage) {
                didBlock = true;
                releaseCommitReady.resolve();
                await releaseCommitBlocked.promise;
            }
            const result = await commitBundle(bundle);
            if (releasesSecondMessage && result === 'conflict') {
                releaseConflictObserved = true;
            }
            return result;
        });

        const { runtime, controlMessages, forwardedIds } = createInboundHarness(stores);

        await runtime.handleIncomingMessage(seq2, { kind: 'ws-client', peerId: 'peer-1' });
        expect(forwardedIds).toEqual([seq2.id.msgId]);

        const pendingRelease = runtime.handleIncomingMessage(seq1, { kind: 'ws-client', peerId: 'peer-1' });
        await releaseCommitReady.promise;

        await runtime.handleIncomingMessage(
            newALAckControlMessage(
                { v: 2, msgId: 'control-release-ack', ts: 1, senderId: 'peer-2' },
                {
                    ackedMsgId: seq2.id.msgId,
                    fromPeerId: 'peer-2',
                    toPeerId: 'self',
                    status: 'delivered',
                    observedAtEpochMs: 1
                }
            ),
            { kind: 'ws-client', peerId: 'peer-2' }
        );

        releaseCommitBlocked.resolve();
        await pendingRelease;
        await vi.advanceTimersByTimeAsync(100);

        const ackPayloads = readAckPayloads(controlMessages);

        expect(releaseConflictObserved).toBe(true);
        expect(ackPayloads).toHaveLength(1);
        expect(ackPayloads[0]).toMatchObject({
            ackedMsgId: seq2.id.msgId,
            toPeerId: 'peer-1',
            status: 'subtree-complete'
        });
        expect(forwardedIds).toEqual([seq2.id.msgId, seq1.id.msgId]);
    });
});

describe('ALInboundMessageRuntime logical acknowledgements', () => {
    it('waits for downstream acknowledgements before sending the deferred subtree ack upstream', async () => {
        const { runtime, controlMessages, forwardedIds, controlAcceptances } = createInboundHarness();

        const msg = newALMulticastMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: 'msg-ack',
                contextId: 'group-1'
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'hello'
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

        await runtime.handleIncomingMessage(msg, { kind: 'ws-client', peerId: 'peer-1' });

        expect(forwardedIds).toEqual([msg.id.msgId]);
        expect(controlMessages).toHaveLength(0);

        await runtime.handleIncomingMessage(
            newALAckControlMessage(
                { v: 2, msgId: 'control-subtree-ack', ts: 1, senderId: 'peer-2' },
                {
                    ackedMsgId: msg.id.msgId,
                    fromPeerId: 'peer-2',
                    toPeerId: 'self',
                    status: 'delivered',
                    observedAtEpochMs: 1
                }
            ),
            { kind: 'ws-client', peerId: 'peer-2' }
        );

        expect(controlAcceptances).toHaveLength(1);
        expect(controlMessages).toHaveLength(1);

        const parsed = parseALControlMessage(controlMessages[0]);
        expect(parsed?.type).toBe('ack');
        expect(parsed?.payload).toMatchObject({
            ackedMsgId: msg.id.msgId,
            toPeerId: 'peer-1',
            status: 'subtree-complete'
        });
    });

    it('drains a completed subtree ack accepted while the current drain is finishing', async () => {
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        const { runtime, controlMessages } = createInboundHarness(stores);
        await runtime.ready();
        const emptyRead = Promise.withResolvers<void>();
        const releaseEmptyRead = Promise.withResolvers<void>();
        const controlStored = Promise.withResolvers<void>();
        const readNextReadyAt = stores.admissionStore.peekNextEffectReadyAt.bind(stores.admissionStore);
        const acceptControlMessage = stores.admissionStore.acceptControlMessage.bind(stores.admissionStore);
        vi.spyOn(stores.admissionStore, 'peekNextEffectReadyAt').mockImplementation(async (nowMs) => {
            const readyAt = await readNextReadyAt(nowMs);
            emptyRead.resolve();
            await releaseEmptyRead.promise;
            return readyAt;
        });
        vi.spyOn(stores.admissionStore, 'acceptControlMessage').mockImplementation(async (message) => {
            const acceptance = await acceptControlMessage(message);
            controlStored.resolve();
            return acceptance;
        });
        const msg = createOrderedMessage(1, 'one', 'all-logical-recipients');

        const admission = runtime.handleIncomingMessage(msg, { kind: 'ws-client', peerId: 'peer-1' });
        await emptyRead.promise;
        const acceptControl = runtime.handleIncomingMessage(
            newALAckControlMessage(
                { v: 2, msgId: 'control-drain-ack', ts: 1, senderId: 'peer-2' },
                {
                    ackedMsgId: msg.id.msgId,
                    fromPeerId: 'peer-2',
                    toPeerId: 'self',
                    status: 'delivered',
                    observedAtEpochMs: 1
                }
            ),
            { kind: 'ws-client', peerId: 'peer-2' }
        );
        await controlStored.promise;
        await new Promise((resolve) => setTimeout(resolve, 0));
        releaseEmptyRead.resolve();
        await Promise.all([admission, acceptControl]);

        const ackPayloads = readAckPayloads(controlMessages);
        expect(ackPayloads).toHaveLength(1);
        expect(ackPayloads[0]).toMatchObject({
            ackedMsgId: msg.id.msgId,
            toPeerId: 'peer-1',
            status: 'subtree-complete'
        });
    });

    it('does not complete deferred subtree ack after the source message expires', async () => {
        vi.useFakeTimers();

        const { runtime, controlMessages, forwardedIds, controlAcceptances } = createInboundHarness();

        const msg = newALMulticastMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: 'msg-expiring-pending-ack',
                contextId: 'group-1'
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'hello'
            },
            {
                ttlMs: 10,
                reliability: 'at-least-once',
                ack: 'all-logical-recipients',
                qos: {
                    durability: {
                        algo: 'volatile'
                    }
                }
            }
        );

        await runtime.handleIncomingMessage(msg, { kind: 'ws-client', peerId: 'peer-1' });

        expect(forwardedIds).toEqual([msg.id.msgId]);
        expect(controlMessages).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(100);
        await runtime.handleIncomingMessage(
            newALAckControlMessage(
                { v: 2, msgId: 'control-expired-ack', ts: 1, senderId: 'peer-2' },
                {
                    ackedMsgId: msg.id.msgId,
                    fromPeerId: 'peer-2',
                    toPeerId: 'self',
                    status: 'delivered',
                    observedAtEpochMs: 1
                }
            ),
            { kind: 'ws-client', peerId: 'peer-2' }
        );

        expect(controlAcceptances).toHaveLength(1);
        expect(controlAcceptances[0]?.completedPendingAcks).toEqual([]);
        expect(controlMessages).toHaveLength(0);
    });
});

describe('ALInboundMessageRuntime durable effects', () => {
    it('retries durable control effects after a transient send failure', async () => {
        vi.useFakeTimers();

        let shouldFailFirstNack = true;
        const sentControls: ALMessage[] = [];
        const { runtime } = createInboundHarness(
            createDefaultInMemoryALInboundRuntimeStores(),
            {
                sendControlMessage: async (msg) => {
                    const parsed = parseALControlMessage(msg);
                    if (parsed?.type === 'nack' && shouldFailFirstNack) {
                        shouldFailFirstNack = false;
                        throw new Error('temporary nack failure');
                    }
                    sentControls.push(msg);
                }
            }
        );

        await runtime.handleIncomingMessage(
            createOrderedMessage(2, 'two'),
            { kind: 'ws-client', peerId: 'peer-1' }
        );

        expect(sentControls.map((msg) => msg.payload.typeId)).toEqual([
            'al.control.repair.v1'
        ]);

        await vi.advanceTimersByTimeAsync(100);

        expect(sentControls.map((msg) => msg.payload.typeId).sort()).toEqual([
            'al.control.nack.v1',
            'al.control.repair.v1'
        ]);
    });

    it('retries durable local dispatch after a transient handler failure', async () => {
        vi.useFakeTimers();

        const delivered: string[] = [];
        let shouldFailFirstDispatch = true;
        const msg = newALMulticastMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: 'msg-dispatch',
                contextId: 'group-1'
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'hello'
            },
            {
                qos: {
                    durability: {
                        algo: 'volatile'
                    }
                }
            }
        );
        const { runtime } = createInboundHarness(
            createDefaultInMemoryALInboundRuntimeStores(),
            {
                dispatchInboxEntry: async (entry) => {
                    const parsed = decodePersistedALMessage(entry.resource);
                    if (shouldFailFirstDispatch) {
                        shouldFailFirstDispatch = false;
                        throw new Error('temporary dispatch failure');
                    }
                    delivered.push(parsed.id.msgId);
                }
            }
        );

        await runtime.handleIncomingMessage(msg, { kind: 'ws-client', peerId: 'peer-1' });

        expect(delivered).toEqual([]);

        await vi.advanceTimersByTimeAsync(100);

        expect(delivered).toEqual([msg.id.msgId]);
    });

    it('does not retry durable local dispatch after the message expires', async () => {
        vi.useFakeTimers();

        const delivered: string[] = [];
        let shouldFailFirstDispatch = true;
        const msg = newALMulticastMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: 'msg-expiring-dispatch',
                contextId: 'group-1'
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'expires'
            },
            {
                ttlMs: 10,
                qos: {
                    durability: {
                        algo: 'volatile'
                    }
                }
            }
        );
        const { runtime } = createInboundHarness(
            createDefaultInMemoryALInboundRuntimeStores(),
            {
                dispatchInboxEntry: async (entry) => {
                    const parsed = decodePersistedALMessage(entry.resource);
                    if (shouldFailFirstDispatch) {
                        shouldFailFirstDispatch = false;
                        throw new Error('temporary dispatch failure');
                    }
                    delivered.push(parsed.id.msgId);
                }
            }
        );

        await runtime.handleIncomingMessage(msg, { kind: 'ws-client', peerId: 'peer-1' });

        expect(delivered).toEqual([]);

        await vi.advanceTimersByTimeAsync(100);

        expect(delivered).toEqual([]);
    });

    it('drops buffered ordered messages once normalized qos expiry has elapsed', async () => {
        vi.useFakeTimers();

        const { runtime, dispatchedTexts } = createInboundHarness();
        const seq2 = {
            ...createOrderedMessage(2, 'two'),
            constraints: undefined,
            qos: {
                expiry: {
                    algo: 'expires-at' as const,
                    opts: {
                        expiresAtMs: Date.now() + 10
                    }
                }
            }
        };
        const seq1 = createOrderedMessage(1, 'one');

        await runtime.handleIncomingMessage(seq2, { kind: 'ws-client', peerId: 'peer-1' });
        await vi.advanceTimersByTimeAsync(100);
        await runtime.handleIncomingMessage(seq1, { kind: 'ws-client', peerId: 'peer-1' });

        expect(dispatchedTexts).toEqual(['one']);
    });

    it('replays persisted durable effects after runtime restart', async () => {
        vi.useFakeTimers();

        const persistence = createInboundPersistenceFixture();
        const stores = persistence.openStores();
        const runtime1 = createInboundHarness(
            stores,
            {
                sendControlMessage: async () => {
                    throw new Error('offline');
                }
            }
        ).runtime;

        await runtime1.handleIncomingMessage(
            createOrderedMessage(2, 'two'),
            { kind: 'ws-client', peerId: 'peer-1' }
        );
        runtime1.dispose();

        const { runtime: runtime2, controlMessages } = createInboundHarness(
            persistence.openStores()
        );
        await runtime2.ready();
        await vi.advanceTimersByTimeAsync(100);

        expect(controlMessages.map((msg) => msg.payload.typeId).sort()).toEqual([
            'al.control.nack.v1',
            'al.control.repair.v1'
        ]);
    });

    it('replays completed pending acks from control-message acceptance after restart', async () => {
        vi.useFakeTimers();

        const persistence = createInboundPersistenceFixture();
        const stores = persistence.openStores();
        const forwardedIds: string[] = [];
        const runtime1 = createInboundHarness(
            stores,
            {
                sendControlMessage: async () => {
                    throw new Error('upstream offline');
                },
                forwardMessage: async (msg) => {
                    forwardedIds.push(msg.id.msgId);
                }
            }
        ).runtime;

        const msg = createOrderedMessage(1, 'one', 'all-logical-recipients');
        await runtime1.handleIncomingMessage(msg, { kind: 'ws-client', peerId: 'peer-1' });
        expect(forwardedIds).toEqual([msg.id.msgId]);

        await runtime1.handleIncomingMessage(
            newALAckControlMessage(
                { v: 2, msgId: 'control-restart-ack', ts: 1, senderId: 'peer-2' },
                {
                    ackedMsgId: msg.id.msgId,
                    fromPeerId: 'peer-2',
                    toPeerId: 'self',
                    status: 'delivered',
                    observedAtEpochMs: 1
                }
            ),
            { kind: 'ws-client', peerId: 'peer-2' }
        );
        runtime1.dispose();

        const { runtime: runtime2, controlMessages } = createInboundHarness(
            persistence.openStores()
        );
        await runtime2.ready();
        await vi.advanceTimersByTimeAsync(100);

        const ackPayloads = readAckPayloads(controlMessages);

        expect(ackPayloads).toHaveLength(1);
        expect(ackPayloads[0]).toMatchObject({
            ackedMsgId: msg.id.msgId,
            toPeerId: 'peer-1',
            status: 'subtree-complete'
        });
    });
});

interface InboundHarnessOverrides {
    readonly dispatchInboxEntry?: (
        entry: ResourceEntry,
        plan?: ALMessageHandlingPlan
    ) => Promise<void>;
    readonly sendControlMessage?: (msg: ALMessage) => Promise<void>;
    readonly forwardMessage?: (
        msg: ALMessage,
        fromPeerId: string,
        plan: ALMessageHandlingPlan
    ) => Promise<void>;
    readonly canForwardMessage?: (msg: ALMessage) => boolean;
}

interface InboundHarness {
    readonly runtime: ALInboundMessageRuntime;
    readonly dispatchedTexts: string[];
    readonly controlMessages: ALMessage[];
    readonly forwardedIds: string[];
    readonly controlAcceptances: ALControlAcceptance[];
}

function createInboundHarness(
    stores = createDefaultInMemoryALInboundRuntimeStores(),
    overrides: InboundHarnessOverrides = {}
): InboundHarness {
    const inbox = new InMemoryQueueBox(new Map());
    const dispatchedTexts: string[] = [];
    const controlMessages: ALMessage[] = [];
    const forwardedIds: string[] = [];
    const controlAcceptances: ALControlAcceptance[] = [];

    const runtime = createDefaultALInboundMessageRuntime({
        selfPeerId: 'self',
        inbox,
        stores,
        planIncomingMessage: (msg, source, observations) =>
            planALMessageHandling(msg, {
                selfPeerId: 'self',
                fromPeerId: source.kind === 'trusted-server' ? undefined : source.peerId,
                connectedPeerIds: ['peer-1', 'peer-2'],
                groupMemberPeerIds: ['self', 'peer-1', 'peer-2'],
                overlayNeighborPeerIds: ['peer-2'],
                ...observations
            }),
        readStoredEntry: (entry) => decodePersistedALMessage(entry.resource),
        toInboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'inbox'),
        dispatchInboxEntry: overrides.dispatchInboxEntry ?? (async (
            entry: ResourceEntry,
            _plan?: ALMessageHandlingPlan
        ) => {
            dispatchedTexts.push(toDeliveredMessageText(entry));
        }),
        sendControlMessage: overrides.sendControlMessage ?? (async (msg) => {
            controlMessages.push(msg);
        }),
        onControlMessage: async (_msg, acceptance) => {
            controlAcceptances.push(acceptance);
        },
        forwardMessage: overrides.forwardMessage ?? (async (msg) => {
            forwardedIds.push(msg.id.msgId);
        }),
        canForwardMessage: overrides.canForwardMessage
    });
    onTestFinished(() => runtime.dispose());

    return {
        runtime,
        dispatchedTexts,
        controlMessages,
        forwardedIds,
        controlAcceptances
    };
}

function toDeliveredMessageText(entry: ResourceEntry): string {
    const msg = decodePersistedALMessage(entry.resource);
    const payload: unknown = JSON.parse(msg.payload.resource);
    const text = typeof payload === 'object' && payload !== null && 'text' in payload ? payload.text : undefined;
    if (text !== undefined && typeof text !== 'string') {
        throw new TypeError('Test message text must be a string');
    }
    return text ?? msg.id.msgId;
}

function readAckPayloads(messages: readonly ALMessage[]) {
    return messages.flatMap((message) => {
        const parsed = parseALControlMessage(message);
        return parsed?.type === 'ack' ? [parsed.payload] : [];
    });
}

function createOrderedMessage(
    seq: number,
    text: string,
    ack: 'none' | 'all-logical-recipients' = 'none'
) {
    return newALMulticastMessage(
        'peer-1',
        {
            topicId: 'chat',
            resourceId: `msg-${seq}`,
            contextId: 'group-1'
        },
        groupRef('group-1'),
        'chat.message.v1',
        {
            text
        },
        {
            seq,
            reliability: 'at-least-once',
            ack,
            qos: {
                durability: {
                    algo: 'volatile'
                }
            }
        }
    );
}

function createSenderScopedDedupMessage(senderId: string, text: string): ALMessage {
    return newALMulticastMessage(
        senderId,
        {
            topicId: 'chat',
            resourceId: `msg-${senderId}`,
            contextId: 'group-1'
        },
        groupRef('group-1'),
        'chat.message.v1',
        { text },
        {
            ack: 'none',
            qos: {
                dedup: { algo: 'msg-id+sender' },
                durability: { algo: 'volatile' }
            }
        }
    );
}

function createInboundPersistenceFixture() {
    const provider = new InMemoryPersistenceProvider<string, unknown>();
    return {
        openStores(): ALInboundRuntimeStores {
            return {
                admissionStore: createALInboundAdmissionStore({
                    namespace: 'al-inbound-runtime-test:provider',
                    backend: new PersistenceProviderAdmissionBackend(
                        provider,
                        'al-inbound-runtime-test:provider',
                        Date.now
                    ),
                    orderingTrackTtlMs: 5 * 60_000,
                    supersedenceTrackTtlMs: 5 * 60_000,
                    retention: normalizeALRuntimeStoreRetention()
                })
            };
        }
    };
}

function groupRef(groupId: string): GroupRef {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId
    };
}
