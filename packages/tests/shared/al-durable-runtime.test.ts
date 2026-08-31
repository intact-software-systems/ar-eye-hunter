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
import { PersistenceProviderAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import type { ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { createDefaultALInboundMessageRuntime } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { createDefaultALOutboundMessageRuntime } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    ALControlPersistenceValue,
    ALOrderingTrackSnapshot,
    ALOutboundMessageRuntime,
    ALSupersedencePersistenceValue,
    createALInboundAdmissionStore,
    createALOutboundAdmissionStore,
    InMemoryPersistenceProvider,
    InMemoryQueueBox,
    newALAckControlMessage,
    newALMulticastMessage,
    newALNackControlMessage,
    newALUnicastMessage,
    normalizeALRuntimeStoreRetention,
    PersistentALControlTracker,
    PersistentALDedupStore,
    PersistentALOrderingStore,
    PersistentALSupersedenceStore,
    planALMessageHandling,
    QueueBoxUtilities,
    type ALMessage,
    type Key,
    type ResourceEntry
} from '@shared/mod.ts';

interface OutboundTestPayload {
    readonly [field: string]: string;
}

interface PersistentAdmissionStorage {
    readonly admissionProvider: InMemoryPersistenceProvider<string, unknown>;
}

interface PersistentRuntimeStoreSet<TStores> extends PersistentAdmissionStorage {
    readonly runtimeStores: TStores;
}

describe('Durable AL runtime stores', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('rehydrates dedup, ordering, and supersedence state from persistence', async () => {
        const nowMs = Date.now();
        const dedupProvider = new InMemoryPersistenceProvider<string, number>();
        const dedup1 = new PersistentALDedupStore(dedupProvider);
        await dedup1.ready();
        await dedup1.mark('msg-1', 50, nowMs);

        const dedup2 = new PersistentALDedupStore(dedupProvider);
        await dedup2.ready();
        expect(dedup2.has('msg-1', nowMs + 25)).toBe(true);
        expect(dedup2.has('msg-1', nowMs + 51)).toBe(false);

        const orderingProvider = new InMemoryPersistenceProvider<string, ALOrderingTrackSnapshot>();
        const ordering1 = new PersistentALOrderingStore(orderingProvider);
        await ordering1.ready();
        await ordering1.accept(createOrderedMessage(2), nowMs);

        const ordering2 = new PersistentALOrderingStore(orderingProvider);
        await ordering2.ready();
        expect(ordering2.peek(createOrderedMessage(1), nowMs + 1)).toMatchObject({
            status: 'in-order',
            releasableSeqs: [2]
        });

        const supersedenceProvider = new InMemoryPersistenceProvider<string, ALSupersedencePersistenceValue>();
        const supersedence1 = new PersistentALSupersedenceStore(
            supersedenceProvider
        );
        await supersedence1.ready();
        await supersedence1.accept(
            {
                key: 'presence:room-1',
                msgId: 'msg-new',
                seq: 2,
                ts: nowMs
            },
            nowMs
        );

        const supersedence2 = new PersistentALSupersedenceStore(
            supersedenceProvider
        );
        await supersedence2.ready();
        expect(
            supersedence2.peek(
                {
                    key: 'presence:room-1',
                    msgId: 'msg-old',
                    seq: 1,
                    ts: nowMs - 1
                },
                nowMs + 1
            )
        ).toMatchObject({
            status: 'superseded',
            latestMsgId: 'msg-new'
        });
    });

    it('rehydrates pending acknowledgements and control event history', async () => {
        const provider = new InMemoryPersistenceProvider<string, ALControlPersistenceValue>();
        const tracker1 = new PersistentALControlTracker(provider);
        await tracker1.ready();

        await tracker1.accept(
            newALNackControlMessage('peer-2', 'self', 'msg-1', 'gap')
        );
        await tracker1.trackPendingAck(
            'msg-1',
            'upstream-peer',
            'subtree-complete',
            ['peer-2'],
            false
        );

        const tracker2 = new PersistentALControlTracker(provider);
        await tracker2.ready();

        expect(tracker2.read('msg-1').nacks).toHaveLength(1);
        expect(tracker2.readPendingAck('msg-1')).toMatchObject({
            toPeerId: 'upstream-peer',
            localReady: false,
            expectedFromPeerIds: ['peer-2'],
            ackedFromPeerIds: []
        });

        expect(await tracker2.markPendingAckLocalReady('msg-1')).toBeUndefined();

        const acceptance = await tracker2.accept(
            newALAckControlMessage('peer-2', 'self', 'msg-1', 'delivered')
        );
        expect(acceptance.completedPendingAcks).toEqual([
            {
                msgId: 'msg-1',
                toPeerId: 'upstream-peer',
                status: 'subtree-complete'
            }
        ]);
    });

    it('keeps inbound dedup decisions across runtime restarts when stores are persisted', async () => {
        const stores = createDefaultPersistentInboundStoreSet();
        const dispatchedMsgIds: string[] = [];

        const runtime1 = createDefaultInboundRuntime(stores, dispatchedMsgIds);
        const msg = newALMulticastMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: 'msg-1',
                contextId: 'group-1'
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'hello'
            },
            {
                reliability: 'at-least-once'
            }
        );

        await runtime1.handleIncomingMessage(msg, 'peer-1');
        expect(dispatchedMsgIds).toEqual([msg.id.msgId]);

        const restartedRuntime = createDefaultInboundRuntime(
            createDefaultPersistentInboundStoreSet(stores),
            dispatchedMsgIds
        );

        await restartedRuntime.handleIncomingMessage(msg, 'peer-1');
        expect(dispatchedMsgIds).toEqual([msg.id.msgId]);
    });

    it('releases buffered ordered messages after restart when the missing sequence arrives', async () => {
        const stores = createDefaultPersistentInboundStoreSet();
        const dispatchedMsgIds: string[] = [];
        const controlMessages: ALMessage[] = [];

        const runtime1 = createDefaultInboundRuntime(stores, dispatchedMsgIds, controlMessages);
        const seq2 = createBufferedOrderedMessage(2, 'two');
        const seq1 = createBufferedOrderedMessage(1, 'one');

        await runtime1.handleIncomingMessage(seq2, 'peer-1');
        expect(dispatchedMsgIds).toEqual([]);

        const runtime2 = createDefaultInboundRuntime(
            createDefaultPersistentInboundStoreSet(stores),
            dispatchedMsgIds,
            controlMessages
        );

        await runtime2.handleIncomingMessage(seq1, 'peer-1');

        expect(dispatchedMsgIds).toEqual([seq1.id.msgId, seq2.id.msgId]);
        expect(controlMessages.map((msg) => msg.payload.typeId)).toContain(
            'al.control.nack.v1'
        );
    });

    it('retransmits cached ordered messages and reuses supersedence keys across outbound restarts', async () => {
        const sent: Array<OutboundTestPayload> = [];
        const outbox = new InMemoryQueueBox(new Map());
        const stores = createDefaultPersistentOutboundStoreSet();

        const runtime1 = createDefaultOutboundRuntime(stores, sent, outbox);
        const firstPresence = newALUnicastMessage(
            'self',
            {
                topicId: 'presence',
                resourceId: 'presence-1',
                contextId: 'room-1'
            },
            'peer-1',
            'presence.state.v1',
            {
                online: true
            }
        );

        const [firstEntry] = await enqueueOutboundOrThrow(runtime1, firstPresence);

        const restartedForSupersedence = createDefaultOutboundRuntime(
            createDefaultPersistentOutboundStoreSet(stores),
            sent,
            outbox
        );
        const secondPresence = newALUnicastMessage(
            'self',
            {
                topicId: 'presence',
                resourceId: 'presence-2',
                contextId: 'room-1'
            },
            'peer-1',
            'presence.state.v1',
            {
                online: false
            }
        );

        const [secondEntry] = await enqueueOutboundOrThrow(restartedForSupersedence, secondPresence);
        expect(secondEntry.key).toEqual(firstEntry.key);

        const seq1 = {
            ...createOutboundMessage('msg-seq-1'),
            ordering: {
                orderingKey: 'conversation-1',
                epoch: 0,
                seq: 1
            }
        };
        const seq2 = {
            ...createOutboundMessage('msg-seq-2'),
            ordering: {
                orderingKey: 'conversation-1',
                epoch: 0,
                seq: 2
            }
        };

        await enqueueOutboundOrThrow(restartedForSupersedence, seq1);
        await enqueueOutboundOrThrow(restartedForSupersedence, seq2);

        const restartedForRepair = createDefaultOutboundRuntime(
            createDefaultPersistentOutboundStoreSet(stores),
            sent,
            outbox
        );

        await restartedForRepair.acceptControlMessage(
            newALNackControlMessage('peer-1', 'self', seq2.id.msgId, 'gap', {
                status: 'gap',
                trackKey: toALOrderingTrackKey(seq1),
                seq: 2,
                expectedSeq: 1,
                lastContiguousSeq: 0,
                missingSeqs: [1],
                releasableSeqs: []
            })
        );

        expect(sent.map((entry) => entry.msgId)).toContain(seq1.id.msgId);
        expect(sent.filter((entry) => entry.msgId === seq1.id.msgId)).toHaveLength(2);
    });

    it('continues pending outbound acknowledgement timers after restart', async () => {
        vi.useFakeTimers();

        const sent: Array<OutboundTestPayload> = [];
        const stores = createDefaultPersistentOutboundStoreSet();
        const runtime1 = createDefaultOutboundRuntime(stores, sent);
        const msg = createOutboundMessage('msg-timeout');

        await enqueueOutboundOrThrow(runtime1, msg);
        runtime1.dispose();

        const runtime2 = createDefaultOutboundRuntime(
            createDefaultPersistentOutboundStoreSet(stores),
            sent
        );
        await runtime2.ready();

        await vi.advanceTimersByTimeAsync(120);

        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' },
            { kind: 'repair', msgId: msg.id.msgId, trigger: 'ack-timeout', phase: 'immediate' }
        ]);
    });

    it('claims a shared pending outbound acknowledgement timeout from only one runtime', async () => {
        vi.useFakeTimers();

        const sent: Array<OutboundTestPayload> = [];
        const stores = createDefaultPersistentOutboundStoreSet();
        const runtime1 = createDefaultOutboundRuntime(stores, sent);
        const msg = createOutboundMessage('msg-shared-timeout');

        await enqueueOutboundOrThrow(runtime1, msg);

        const runtime2 = createDefaultOutboundRuntime(
            createDefaultPersistentOutboundStoreSet(stores),
            sent
        );
        await runtime2.ready();

        await vi.advanceTimersByTimeAsync(120);

        expect(sent.filter((entry) => entry.kind === 'send')).toHaveLength(1);
        expect(sent.filter((entry) => entry.kind === 'repair')).toHaveLength(1);

        runtime1.dispose();
        runtime2.dispose();
    });
});

async function enqueueOutboundOrThrow(
    runtime: Pick<ALOutboundMessageRuntime<OutboundTestPayload>, 'enqueueIfAbsent'>,
    msg: ALMessage
): Promise<readonly ResourceEntry[]> {
    const enqueued = await runtime.enqueueIfAbsent(msg);
    if (enqueued.status === 'failed') {
        throw new Error(enqueued.reason);
    }

    return enqueued.entries;
}

function createDefaultPersistentInboundStoreSet(
    existing?: PersistentAdmissionStorage
): PersistentRuntimeStoreSet<ALInboundRuntimeStores> {
    const admissionProvider = existing?.admissionProvider ??
        new InMemoryPersistenceProvider<string, unknown>();

    return {
        admissionProvider,
        runtimeStores: {
            admissionStore: createALInboundAdmissionStore({
                namespace: 'durable-test:inbound:admission',
                backend: new PersistenceProviderAdmissionBackend(
                    admissionProvider,
                    'durable-test:inbound:admission'
                ),
                orderingTrackTtlMs: 5 * 60_000,
                supersedenceTrackTtlMs: 5 * 60_000,
                retention: normalizeALRuntimeStoreRetention()
            })
        }
    };
}

function createDefaultInboundRuntime(
    stores: PersistentRuntimeStoreSet<ALInboundRuntimeStores>,
    dispatchedMsgIds: string[],
    controlMessages: ALMessage[] = []
) {
    const runtime = createDefaultALInboundMessageRuntime({
        selfPeerId: 'self',
        inbox: new InMemoryQueueBox(new Map<Key, ResourceEntry>()),
        stores: stores.runtimeStores,
        planIncomingMessage: (msg, fromPeerId, runtime) =>
            planALMessageHandling(msg, {
                selfPeerId: 'self',
                fromPeerId,
                connectedPeerIds: ['peer-1', 'peer-2'],
                groupMemberPeerIds: ['self', 'peer-1', 'peer-2'],
                overlayNeighborPeerIds: ['peer-2'],
                dedupStore: runtime.dedupStore,
                orderingStore: runtime.orderingStore,
                supersedenceStore: runtime.supersedenceStore
            }),
        readStoredEntry: (entry) => decodePersistedALMessage(entry.resource),
        toInboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'inbox'),
        dispatchInboxEntry: async (entry: ResourceEntry) => {
            const msg = decodePersistedALMessage(entry.resource);
            dispatchedMsgIds.push(msg.id.msgId);
        },
        sendControlMessage: async (msg) => {
            controlMessages.push(msg);
        }
    });
    onTestFinished(() => runtime.dispose());
    return runtime;
}

function createDefaultPersistentOutboundStoreSet(
    existing?: PersistentAdmissionStorage
): PersistentRuntimeStoreSet<ALOutboundRuntimeStores> {
    const admissionProvider = existing?.admissionProvider ??
        new InMemoryPersistenceProvider<string, unknown>();

    return {
        admissionProvider,
        runtimeStores: {
            admissionStore: createALOutboundAdmissionStore({
                namespace: 'durable-test:outbound:admission',
                backend: new PersistenceProviderAdmissionBackend(
                    admissionProvider,
                    'durable-test:outbound:admission'
                ),
                supersedenceTrackTtlMs: 5 * 60_000,
                retention: normalizeALRuntimeStoreRetention()
            })
        }
    };
}

function createDefaultOutboundRuntime(
    stores: PersistentRuntimeStoreSet<ALOutboundRuntimeStores>,
    sent: Array<OutboundTestPayload>,
    outbox: InMemoryQueueBox = new InMemoryQueueBox(new Map())
) {
    const runtime = createDefaultALOutboundMessageRuntime<OutboundTestPayload>({
        outbox,
        stores: stores.runtimeStores,
        toOutboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox'),
        readMessageFromEntry: (entry) => decodePersistedALMessage(entry.resource),
        planOutgoingMessage: (msg) => ({
            persist: msg.payload.typeId === 'presence.state.v1',
            preparedMessages: msg.payload.typeId === 'presence.state.v1'
                ? []
                : [{ kind: 'send', msgId: msg.id.msgId }],
            ackTracking: msg.payload.typeId === 'presence.state.v1'
                ? undefined
                : {
                    enabled: true,
                    timeoutMs: 100,
                    maxAttempts: 1,
                    expectedPeerIds: ['peer-1']
                },
            repairTracking: msg.payload.typeId === 'presence.state.v1'
                ? undefined
                : {
                    enabled: true,
                    algo: 'retransmit',
                    maxAttempts: 1
                },
            supersedenceTracking: msg.payload.typeId === 'presence.state.v1'
                ? {
                    enabled: true,
                    algo: 'latest-wins',
                    key: `presence:${msg.route.contextId}`
                }
                : undefined
        }),
        planRepairMessage: async (msg, request) => ({
            persist: false,
            preparedMessages: [
                {
                    kind: 'repair',
                    msgId: msg.id.msgId,
                    trigger: request.trigger
                }
            ]
        }),
        sendPreparedMessage: async (prepared, phase) => {
            sent.push({ ...prepared, phase });
        }
    });
    onTestFinished(() => runtime.dispose());
    return runtime;
}

function createOrderedMessage(seq: number): ALMessage {
    return {
        ...newALMulticastMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: `msg-${seq}`,
                contextId: 'group-1'
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: `message-${seq}`
            },
            {
                seq,
                reliability: 'at-least-once'
            }
        ),
        ordering: {
            orderingKey: 'group-1',
            epoch: 0,
            seq
        }
    };
}

function createBufferedOrderedMessage(seq: number, text: string) {
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

function createOutboundMessage(resourceId: string) {
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

function groupRef(groupId: string): GroupRef {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId
    };
}
