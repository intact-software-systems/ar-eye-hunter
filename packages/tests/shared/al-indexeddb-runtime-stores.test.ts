// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { createDefaultALInboundMessageRuntime } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { createDefaultALOutboundMessageRuntime } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import {
    ALOutboundMessageRuntime,
    createDefaultIndexedDbALInboundRuntimeStores,
    createDefaultIndexedDbALOutboundRuntimeStores,
    IndexedDbQueueBox,
    IndexedDbStringPersistenceProvider,
    InMemoryQueueBox,
    newALAckControlMessage,
    newALMulticastMessage,
    newALNackControlMessage,
    newALUnicastMessage,
    planALMessageHandling,
    QueueBoxUtilities,
    type ALInboundAdmissionStore,
    type ALInboundPlanner,
    type ALInboundRuntimeStores,
    type ALMessage,
    type ALOutboundPlanner,
    type ALOutboundPreparedMessageDecoder,
    type ClaimALOutboundEffectsInput,
    type ResourceEntry
} from '@shared/mod.ts';

import '../setup-browser-indexeddb.ts';
import { createFlakyOutboundAdmissionStore, enqueueOutboundOrThrow } from './alm/outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from './alm/outbound-test-payload.ts';

describe('IndexedDB AL runtime stores', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('keeps the default AL schema separate from generic persistence', async () => {
        const persistence = new IndexedDbStringPersistenceProvider<string>();
        await persistence.setItem(
            'generic-entry',
            'generic-value',
            { expireAtTimestamp: Date.now() + 60_000 }
        );
        const inboundStores = createDefaultIndexedDbALInboundRuntimeStores();
        const outboundStores = createDefaultIndexedDbALOutboundRuntimeStores();

        await expect(
            inboundStores.admissionStore.commitMutations({
                senderId: 'peer-default-schema',
                expectedVersion: undefined,
                versionExpireAtTimestamp: Date.now() + 60_000,
                mutations: [{
                    kind: 'set-msg-owner',
                    msgId: 'message-default-schema',
                    senderId: 'peer-default-schema',
                    source: { kind: 'ws-client', peerId: 'peer-default-schema' },
                    supersedenceKey: null,
                    expireAtTimestamp: Date.now() + 60_000
                }]
            })
        ).resolves.toBe('committed');
        await expect(outboundStores.admissionStore.ready()).resolves.toBeUndefined();
        await expect(persistence.getItem('generic-entry')).resolves.toBe('generic-value');
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
                contextId: 'conversation-1'
            },
            'self',
            'chat.private-text.v1',
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

        const runtime1 = createDefaultInboundRuntime({ dbName: dbName, namespace: namespace, dispatchedMsgIds: dispatchedMsgIds });
        await runtime1.handleIncomingMessage(msg, { kind: 'ws-client', peerId: 'peer-1' });
        expect(dispatchedMsgIds).toEqual([msg.id.msgId]);

        const runtime2 = createDefaultInboundRuntime({ dbName: dbName, namespace: namespace, dispatchedMsgIds: dispatchedMsgIds });
        await runtime2.handleIncomingMessage(msg, { kind: 'ws-client', peerId: 'peer-1' });
        expect(dispatchedMsgIds).toEqual([msg.id.msgId]);
    });

    it('releases buffered ordered messages after restart', async () => {
        const dbName = `al-runtime-${crypto.randomUUID()}`;
        const namespace = 'rtc-inbound';
        const dispatchedMsgIds: string[] = [];
        const runtime1 = createDefaultInboundRuntime({ dbName: dbName, namespace: namespace, dispatchedMsgIds: dispatchedMsgIds });
        const seq2 = createOrderedMulticastMessage(2, 'two');
        const seq1 = createOrderedMulticastMessage(1, 'one');

        await runtime1.handleIncomingMessage(seq2, { kind: 'ws-client', peerId: 'peer-1' });
        expect(dispatchedMsgIds).toEqual([]);

        const runtime2 = createDefaultInboundRuntime({ dbName: dbName, namespace: namespace, dispatchedMsgIds: dispatchedMsgIds });
        await runtime2.handleIncomingMessage(seq1, { kind: 'ws-client', peerId: 'peer-1' });

        expect(dispatchedMsgIds).toEqual([seq1.id.msgId, seq2.id.msgId]);
    });

    it('keeps admission state and inbox queue data in owner-specific databases', async () => {
        const dbName = `al-runtime-${crypto.randomUUID()}`;
        const namespace = 'shared-browser-db';
        const inboxStoreName = 'queuebox:inbox';
        const inbox = new IndexedDbQueueBox({
            dbName: `${dbName}:${inboxStoreName}`,
            storeName: inboxStoreName
        });
        const dispatchedMsgIds: string[] = [];
        const runtime = createDefaultALInboundMessageRuntime({
            selfPeerId: 'self',
            inbox,
            stores: createDefaultIndexedDbALInboundRuntimeStores({
                dbName,
                namespace
            }),
            planIncomingMessage: (msg, source, observations) =>
                planALMessageHandling(msg, {
                    selfPeerId: 'self',
                    fromPeerId: source.kind === 'trusted-server' ? undefined : source.peerId,
                    ...observations
                }),
            readStoredEntry: (entry) => decodePersistedALMessage(entry.resource),
            toInboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'inbox'),
            dispatchInboxEntry: async (entry) => {
                const msg = decodePersistedALMessage(entry.resource);
                dispatchedMsgIds.push(msg.id.msgId);
            },
            sendControlMessage: async () => Promise.resolve()
        });
        onTestFinished(() => runtime.dispose());
        const msg = newALUnicastMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: 'msg-shared-db',
                contextId: 'conversation-1'
            },
            'self',
            'chat.private-text.v1',
            {
                text: 'persist me'
            }
        );

        await inbox.getAllKeys();
        await runtime.ready();
        await runtime.handleIncomingMessage(msg, { kind: 'ws-client', peerId: 'peer-1' });

        expect(dispatchedMsgIds).toEqual([msg.id.msgId]);
        expect(await inbox.getAllKeys()).toEqual([]);
    });

    it('persists inbound local-inbox effects without leaking Temporal values into IndexedDB', async () => {
        const dbName = `al-runtime-${crypto.randomUUID()}`;
        const namespace = 'rtc-inbound-local-inbox';
        const stores = createDefaultIndexedDbALInboundRuntimeStores({
            dbName,
            namespace
        });
        const runtime = createDefaultInboundRuntime({
            dbName: dbName,
            namespace: namespace,
            dispatchedMsgIds: [],
            stores: {
                ...stores,
                admissionStore: createFlakyInboundAdmissionStore(stores.admissionStore, {
                    claimReadyEffects: async () => []
                })
            }
        });
        const msg = newALUnicastMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: 'msg-local-inbox',
                contextId: 'conversation-1'
            },
            'self',
            'chat.private-text.v1',
            {
                text: 'persist me later'
            },
            {
                qos: {
                    durability: {
                        algo: 'local-inbox'
                    }
                }
            }
        );

        await runtime.handleIncomingMessage(msg, { kind: 'ws-client', peerId: 'peer-1' });
        runtime.dispose();

        const claimed = await stores.admissionStore.claimReadyEffects({
            workerId: 'inspector',
            maxCount: 10,
            leaseMs: 1_000,
            nowMs: Date.now()
        });
        const inboxEffect = claimed.find((effect) => effect.payload.kind === 'enqueue-inbox');

        expect(inboxEffect).toBeDefined();
        expect(inboxEffect?.payload.kind).toBe('enqueue-inbox');
        if (!inboxEffect || inboxEffect.payload.kind !== 'enqueue-inbox') {
            throw new Error('Expected an enqueue-inbox effect');
        }

        expect(JSON.parse(inboxEffect.payload.entry.resource)).toMatchObject({
            id: {
                msgId: msg.id.msgId
            }
        });
        expect(typeof inboxEffect.payload.entry.audit.date).toBe('object');
        expect(typeof inboxEffect.payload.entry.audit.createdTs).toBe('object');
        expect(typeof inboxEffect.payload.entry.audit.expiryTs).toBe('object');
    });

    it('expires inbound control history and owner versions before rejecting late controls', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const dbName = `al-runtime-${crypto.randomUUID()}`;
        const namespace = 'rtc-inbound-retention';
        const stores = createDefaultIndexedDbALInboundRuntimeStores({
            dbName,
            namespace,
            retention: {
                controlHistoryTtlMs: 20,
                msgOwnerTtlMs: 20,
                versionTtlMs: 20
            }
        });
        const msg = newALUnicastMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: 'msg-inbound-retention',
                contextId: 'conversation-1'
            },
            'self',
            'chat.private-text.v1',
            {
                text: 'retained briefly'
            }
        );
        const planner = createInboundPlanner();

        expect(
            await stores.admissionStore.commitMutations({
                senderId: msg.id.senderId,
                expectedVersion: undefined,
                versionExpireAtTimestamp: Date.now() + 20,
                mutations: [
                    {
                        kind: 'set-msg-owner',
                        msgId: msg.id.msgId,
                        senderId: msg.id.senderId,
                        source: { kind: 'ws-client', peerId: msg.id.senderId },
                        supersedenceKey: null,
                        expireAtTimestamp: Date.now() + 20
                    },
                    {
                        kind: 'set-control-pending',
                        msgId: msg.id.msgId,
                        senderId: msg.id.senderId,
                        value: {
                            kind: 'pending',
                            value: {
                                toPeerId: 'upstream',
                                status: 'subtree-complete',
                                localReady: false,
                                expectedFromPeerIds: ['peer-2', 'peer-3'],
                                ackedFromPeerIds: []
                            }
                        },
                        expireAtTimestamp: Date.now() + 20
                    },
                    {
                        kind: 'set-control-owners',
                        msgId: msg.id.msgId,
                        expected: undefined,
                        value: {
                            ambiguous: false,
                            values: [
                                { peerId: 'peer-2', senderId: msg.id.senderId },
                                { peerId: 'peer-3', senderId: msg.id.senderId }
                            ]
                        },
                        expireAtTimestamp: Date.now() + 20
                    }
                ]
            })
        ).toBe('committed');

        await stores.admissionStore.acceptControlMessage(
            newALAckControlMessage(
                { v: 2, msgId: 'control-ack-peer-2', ts: 1, senderId: 'peer-2' },
                {
                    ackedMsgId: msg.id.msgId,
                    fromPeerId: 'peer-2',
                    toPeerId: 'self',
                    status: 'accepted',
                    observedAtEpochMs: 1
                }
            )
        );

        const source = { kind: 'ws-client' as const, peerId: 'peer-1' };
        const beforeReadAtMs = Date.now();
        const beforeExpiry = await stores.admissionStore.readIncomingMessage({
            msg,
            source,
            nowMs: beforeReadAtMs,
            prePlan: planner(msg, source, { nowMs: beforeReadAtMs })
        });
        expect(beforeExpiry.clientRecord?.version).toBe(2);
        expect(beforeExpiry.acks).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(21);

        await expect(stores.admissionStore.acceptControlMessage(
            newALAckControlMessage(
                { v: 2, msgId: 'control-ack-peer-3', ts: 2, senderId: 'peer-3' },
                {
                    ackedMsgId: msg.id.msgId,
                    fromPeerId: 'peer-3',
                    toPeerId: 'self',
                    status: 'accepted',
                    observedAtEpochMs: 2
                }
            )
        )).resolves.toEqual({ handled: false, completedPendingAcks: [] });

        const afterReadAtMs = Date.now();
        const afterExpiry = await stores.admissionStore.readIncomingMessage({
            msg,
            source,
            nowMs: afterReadAtMs,
            prePlan: planner(msg, source, { nowMs: afterReadAtMs })
        });
        expect(afterExpiry.clientRecord).toBeUndefined();
        expect(afterExpiry.acks).toEqual([]);
    });

    it('expires outbound sent snapshots without explicit message expiry using repository defaults', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const dbName = `al-runtime-${crypto.randomUUID()}`;
        const namespace = 'rtc-outbound-retention-defaults';
        const sent: Array<OutboundTestPayload> = [];
        const stores = createDefaultIndexedDbALOutboundRuntimeStores({
            dbName,
            namespace
        });
        const admissionStore = stores.admissionStore;
        const runtime = createDefaultOutboundRuntime({ dbName: dbName, namespace: namespace, sent: sent, stores });
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
        const stores = createDefaultIndexedDbALOutboundRuntimeStores({
            dbName,
            namespace,
            retention: {
                controlHistoryTtlMs: 20,
                repairAttemptTtlMs: 20,
                repositoryTtlMs: 60_000
            }
        });
        const admissionStore = stores.admissionStore;
        const msg = createOutboundUnicastMessage('msg-outbound-ephemeral-retention');
        const planner = createOutboundPlanner();

        expect(
            await admissionStore.commitBundle({
                senderId: msg.id.senderId,
                expectedVersion: undefined,
                mutations: [
                    {
                        kind: 'set-msg-owner',
                        msgId: msg.id.msgId,
                        senderId: msg.id.senderId
                    },
                    {
                        kind: 'set-sent-message',
                        snapshot: {
                            msgId: msg.id.msgId,
                            msg
                        }
                    },
                    {
                        kind: 'set-repair-attempt',
                        snapshot: {
                            msgId: msg.id.msgId,
                            attempts: 1
                        }
                    }
                ],
                durableEffects: []
            }, decodeOutboundTestPayload)
        ).toBe('committed');

        await admissionStore.acceptControlMessage(
            newALNackControlMessage(
                { v: 2, msgId: 'control-gap', ts: 1, senderId: 'peer-1' },
                {
                    msgId: msg.id.msgId,
                    fromPeerId: 'peer-1',
                    toPeerId: 'self',
                    reason: 'gap',
                    observedAtEpochMs: 1
                }
            ),
            decodeOutboundTestPayload
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
        const sent: Array<OutboundTestPayload> = [];
        const runtime1 = createDefaultOutboundRuntime({ dbName: dbName, namespace: namespace, sent: sent });
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

        await enqueueOutboundOrThrow(runtime1, seq1);
        await enqueueOutboundOrThrow(runtime1, seq2);
        runtime1.dispose();

        const runtime2 = createDefaultOutboundRuntime({ dbName: dbName, namespace: namespace, sent: sent });
        await runtime2.acceptControlMessage(
            newALNackControlMessage(
                { v: 2, msgId: 'control-ordering-gap', ts: 1, senderId: 'peer-1' },
                {
                    msgId: seq2.id.msgId,
                    fromPeerId: 'peer-1',
                    toPeerId: 'self',
                    reason: 'gap',
                    observedAtEpochMs: 1,
                    orderingKey: toALOrderingTrackKey(seq1),
                    expectedSeq: 1,
                    missingSeqs: [1]
                }
            )
        );

        await expect.poll(() => sent.filter((entry) => entry.msgId === seq1.id.msgId)).toHaveLength(2);
    });

    it('drains committed outbound effects from IndexedDB after restart', async () => {
        const dbName = `al-runtime-${crypto.randomUUID()}`;
        const namespace = 'rtc-outbound-crash-before-drain';
        const sent: Array<OutboundTestPayload> = [];
        const stores = createDefaultIndexedDbALOutboundRuntimeStores({
            dbName,
            namespace
        });
        const admissionStore = stores.admissionStore;
        const msg = createOutboundUnicastMessage('msg-indexeddb-crash-before-drain');
        const runtime1 = createDefaultOutboundRuntime({
            dbName: dbName,
            namespace: namespace,
            sent: sent,
            stores: {
                ...stores,
                admissionStore: createFlakyOutboundAdmissionStore(admissionStore, {
                    claimReadyEffects: async () => []
                })
            }
        });

        await enqueueOutboundOrThrow(runtime1, msg);
        runtime1.dispose();
        expect(sent).toEqual([]);

        const runtime2 = createDefaultOutboundRuntime({ dbName: dbName, namespace: namespace, sent: sent });
        await runtime2.ready();

        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' }
        ]);
        runtime2.dispose();
    });

    it('lets only one runtime claim the same IndexedDB outbound effect', async () => {
        const dbName = `al-runtime-${crypto.randomUUID()}`;
        const namespace = 'rtc-outbound-single-claim';
        const sent: Array<OutboundTestPayload> = [];
        const stores = createDefaultIndexedDbALOutboundRuntimeStores({
            dbName,
            namespace
        });
        const admissionStore = stores.admissionStore;
        const msg = createOutboundUnicastMessage('msg-indexeddb-single-claim');
        const runtime1 = createDefaultOutboundRuntime({
            dbName: dbName,
            namespace: namespace,
            sent: sent,
            stores: {
                ...stores,
                admissionStore: createFlakyOutboundAdmissionStore(admissionStore, {
                    claimReadyEffects: async () => []
                })
            }
        });

        await enqueueOutboundOrThrow(runtime1, msg);
        runtime1.dispose();
        expect(sent).toEqual([]);

        const sendStarted = Promise.withResolvers<void>();
        const sendBarrier = Promise.withResolvers<void>();
        const sendPreparedMessage: ALOutboundMessageRuntime.Dependencies<OutboundTestPayload>['sendPreparedMessage'] = async (
            prepared,
            phase
        ) => {
            sent.push({ ...prepared, phase });
            sendStarted.resolve();
            await sendBarrier.promise;

            return { status: 'sent' as const };
        };
        const runtime2 = createDefaultOutboundRuntime({ dbName: dbName, namespace: namespace, sent: sent, sendPreparedMessage });
        const runtime3 = createDefaultOutboundRuntime({ dbName: dbName, namespace: namespace, sent: sent, sendPreparedMessage });
        const drain = Promise.all([runtime2.ready(), runtime3.ready()]);

        await sendStarted.promise;
        await Promise.resolve();
        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' }
        ]);

        sendBarrier.resolve();
        await drain;
        runtime2.dispose();
        runtime3.dispose();
    });

    it('does not repair from IndexedDB when an acknowledgement is accepted while timeout is claimed', async () => {
        const dbName = `al-runtime-${crypto.randomUUID()}`;
        const namespace = 'rtc-outbound-ack-timeout-race';
        const sent: Array<OutboundTestPayload> = [];
        const stores = createDefaultIndexedDbALOutboundRuntimeStores({
            dbName,
            namespace
        });
        const admissionStore = stores.admissionStore;
        const msg = createOutboundUnicastMessage('msg-indexeddb-ack-during-timeout');
        let acceptedAckDuringTimeout = false;
        const runtime = createDefaultOutboundRuntime({
            dbName: dbName,
            namespace: namespace,
            sent: sent,
            stores: {
                ...stores,
                admissionStore: createFlakyOutboundAdmissionStore(admissionStore, {
                    claimReadyEffects: async <TPrepared>(input: ClaimALOutboundEffectsInput, decode: ALOutboundPreparedMessageDecoder<TPrepared>) => {
                        const effects = await admissionStore.claimReadyEffects(input, decode);
                        if (
                            !acceptedAckDuringTimeout &&
                            effects.some((effect) => effect.payload.kind === 'ack-timeout')
                        ) {
                            acceptedAckDuringTimeout = true;
                            await admissionStore.acceptControlMessage(
                                newALAckControlMessage(
                                    { v: 2, msgId: 'control-timeout-ack', ts: 1, senderId: 'peer-1' },
                                    {
                                        ackedMsgId: msg.id.msgId,
                                        fromPeerId: 'peer-1',
                                        toPeerId: 'self',
                                        status: 'accepted',
                                        observedAtEpochMs: 1
                                    }
                                ),
                                decode
                            );
                        }

                        return effects;
                    }
                })
            },
            planOutgoingMessage: (plannedMsg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: plannedMsg.id.msgId }],
                ackTracking: {
                    enabled: true,
                    timeoutMs: 10,
                    maxAttempts: 1,
                    expectedPeerIds: ['peer-1']
                },
                repairTracking: {
                    enabled: true,
                    algo: 'retransmit',
                    maxAttempts: 1
                }
            }),
            planRepairMessage: async (plannedMsg, request) => ({
                persist: false,
                preparedMessages: [
                    {
                        kind: 'repair',
                        msgId: plannedMsg.id.msgId,
                        trigger: request.trigger
                    }
                ]
            })
        });

        await enqueueOutboundOrThrow(runtime, msg);
        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' }
        ]);

        await expect.poll(() => acceptedAckDuringTimeout).toBe(true);
        await expect.poll(() => admissionStore.peekNextEffectReadyAt()).toBeUndefined();
        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' }
        ]);
        runtime.dispose();
    });
});

interface IndexedDbInboundFixtureInput {
    readonly dbName: string;
    readonly namespace: string;
    readonly dispatchedMsgIds: string[];
    readonly stores?: ALInboundRuntimeStores;
}

function createDefaultInboundRuntime(input: IndexedDbInboundFixtureInput) {
    const { dbName, namespace, dispatchedMsgIds } = input;
    const runtime = createDefaultALInboundMessageRuntime({
        selfPeerId: 'self',
        inbox: new InMemoryQueueBox(new Map()),
        stores: input.stores ?? createDefaultIndexedDbALInboundRuntimeStores({
            dbName,
            namespace
        }),
        planIncomingMessage: (msg, source, observations) =>
            planALMessageHandling(msg, {
                selfPeerId: 'self',
                fromPeerId: source.kind === 'trusted-server' ? undefined : source.peerId,
                ...observations
            }),
        readStoredEntry: (entry) => decodePersistedALMessage(entry.resource),
        toInboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'inbox'),
        dispatchInboxEntry: async (entry: ResourceEntry) => {
            const msg = decodePersistedALMessage(entry.resource);
            dispatchedMsgIds.push(msg.id.msgId);
        },
        sendControlMessage: async () => Promise.resolve()
    });
    onTestFinished(() => runtime.dispose());
    return runtime;
}

function createInboundPlanner(): ALInboundPlanner {
    return (msg, source, observations) =>
        planALMessageHandling(msg, {
            selfPeerId: 'self',
            fromPeerId: source.kind === 'trusted-server' ? undefined : source.peerId,
            ...observations
        });
}

function createFlakyInboundAdmissionStore(
    inner: ALInboundAdmissionStore,
    hooks: Partial<Pick<ALInboundAdmissionStore, 'claimReadyEffects' | 'commitBundle' | 'commitMutations'>>
): ALInboundAdmissionStore {
    return {
        ready: () => inner.ready(),
        readIncomingMessage: (input) => inner.readIncomingMessage(input),
        readBufferedRelease: (input) => inner.readBufferedRelease(input),
        readDeliveryPredecessors: (trackKey, beforeSeq) => inner.readDeliveryPredecessors(trackKey, beforeSeq),
        readStoredPlanningState: (input) => inner.readStoredPlanningState(input),
        commitMutations: (request) =>
            hooks.commitMutations
                ? hooks.commitMutations(request)
                : inner.commitMutations(request),
        commitBundle: (bundle) =>
            hooks.commitBundle
                ? hooks.commitBundle(bundle)
                : inner.commitBundle(bundle),
        claimReadyEffects: (input) =>
            hooks.claimReadyEffects
                ? hooks.claimReadyEffects(input)
                : inner.claimReadyEffects(input),
        completeEffect: (effectId, workerId) => inner.completeEffect(effectId, workerId),
        rescheduleEffect: (input) => inner.rescheduleEffect(input),
        peekNextEffectReadyAt: (nowMs) => inner.peekNextEffectReadyAt(nowMs),
        acceptControlMessage: (msg) => inner.acceptControlMessage(msg)
    };
}

interface IndexedDbOutboundFixtureInput {
    readonly dbName: string;
    readonly namespace: string;
    readonly sent: Array<OutboundTestPayload>;
    readonly stores?: ALOutboundRuntimeStores;
    readonly planOutgoingMessage?: ALOutboundMessageRuntime.Dependencies<OutboundTestPayload>['planOutgoingMessage'];
    readonly planRepairMessage?: ALOutboundMessageRuntime.Dependencies<OutboundTestPayload>['planRepairMessage'];
    readonly sendPreparedMessage?: ALOutboundMessageRuntime.Dependencies<OutboundTestPayload>['sendPreparedMessage'];
}

function createDefaultOutboundRuntime(input: IndexedDbOutboundFixtureInput) {
    const { dbName, namespace, sent } = input;
    const runtime = createDefaultALOutboundMessageRuntime<OutboundTestPayload>({
        outbox: new InMemoryQueueBox(new Map()),
        stores: input.stores ?? createDefaultIndexedDbALOutboundRuntimeStores({
            dbName,
            namespace
        }),
        toOutboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox'),
        decodePreparedMessage: decodeOutboundTestPayload,
        readMessageFromEntry: (entry) => decodePersistedALMessage(entry.resource),
        planOutgoingMessage: input.planOutgoingMessage ?? ((msg) => ({
            persist: false,
            preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
            repairTracking: {
                enabled: true,
                algo: 'retransmit',
                maxAttempts: 1
            }
        })),
        planRepairMessage: input.planRepairMessage ?? (async (msg, request) => ({
            persist: false,
            preparedMessages: [
                {
                    kind: 'repair',
                    msgId: msg.id.msgId,
                    trigger: request.trigger
                }
            ]
        })),
        sendPreparedMessage: input.sendPreparedMessage ?? (async (prepared, phase) => {
            sent.push({ ...prepared, phase });

            return { status: 'sent' as const };
        })
    });
    onTestFinished(() => runtime.dispose());
    return runtime;
}

function createOutboundPlanner(): ALOutboundPlanner<OutboundTestPayload> {
    return (msg) => ({
        persist: false,
        preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
        repairTracking: {
            enabled: true,
            algo: 'retransmit',
            maxAttempts: 1
        }
    });
}

function createOutboundUnicastMessage(resourceId: string) {
    return newALUnicastMessage(
        'self',
        {
            topicId: 'chat',
            resourceId,
            contextId: 'conversation-1'
        },
        'peer-1',
        'chat.private-text.v1',
        {
            text: resourceId
        }
    );
}

function createOrderedMulticastMessage(seq: number, text: string) {
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
            ack: 'none',
            qos: {
                durability: {
                    algo: 'volatile'
                }
            }
        }
    );
}

function groupRef(groupId: string) {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId
    };
}
