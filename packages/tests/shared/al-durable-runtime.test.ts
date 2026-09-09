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
import {
    createInMemoryALAdmissionState,
    InMemoryAdmissionBackend,
    type ALAdmissionMemoryState
} from '@shared/alm/al-admission-backend.ts';
import type { ALInboundMessageRuntime, ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { createDefaultALInboundMessageRuntime } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import type { ALOutboundDispatchPlan, ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { createDefaultALOutboundMessageRuntime } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    ALOutboundMessageRuntime,
    createALInboundAdmissionStore,
    createALOutboundAdmissionStore,
    newALMulticastMessage,
    newALNackControlMessage,
    newALUnicastMessage,
    normalizeALRuntimeStoreRetention,
    planALMessageHandling,
    QueueBoxUtilities,
    type ALMessage,
    type ResourceEntry
} from '@shared/mod.ts';

import { decodeOutboundTestPayload, type OutboundTestPayload } from './alm/outbound-test-payload.ts';
import { waitForSettledALInboundWork } from './wait-for-al-inbound-work.ts';

interface RetainedAdmissionState {
    readonly admissionState: ALAdmissionMemoryState;
}

interface RetainedRuntimeStoreSet<TStores> extends RetainedAdmissionState {
    readonly runtimeStores: TStores;
}

describe('AL state retained across runtime recreation', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('keeps inbound dedup decisions across runtime restarts when the storage owner is retained', async () => {
        const stores = createRetainedInboundStoreSet();
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
            { ttlMs: 30_000, reliability: 'at-least-once' }
        );

        await runtime1.admitIncomingMessage(msg, { kind: 'ws-client', peerId: 'peer-1' });
        await expect.poll(() => dispatchedMsgIds).toEqual([msg.id.msgId]);

        runtime1.dispose();
        const restartedStores = createRetainedInboundStoreSet(stores);
        const restartedRuntime = createDefaultInboundRuntime(restartedStores, dispatchedMsgIds);

        await restartedRuntime.admitIncomingMessage(msg, { kind: 'ws-client', peerId: 'peer-1' });

        // The redelivered duplicate must not dispatch again: settle every retained row before reading.
        await waitForSettledALInboundWork(restartedStores.runtimeStores.workQueue);
        expect(dispatchedMsgIds).toEqual([msg.id.msgId]);
    });

    it('releases buffered ordered messages after restart when the missing sequence arrives', async () => {
        const stores = createRetainedInboundStoreSet();
        const dispatchedMsgIds: string[] = [];
        const controlMessages: ALMessage[] = [];

        const runtime1 = createDefaultInboundRuntime(stores, dispatchedMsgIds, controlMessages);
        const seq2 = createBufferedOrderedMessage(2, 'two');
        const seq1 = createBufferedOrderedMessage(1, 'one');

        await runtime1.admitIncomingMessage(seq2, { kind: 'ws-client', peerId: 'peer-1' });

        // A gap retains no deliverable work, so the settled queue is read beside the fence that holds it.
        await waitForSettledALInboundWork(stores.runtimeStores.workQueue);
        await expect.poll(() =>
            stores.runtimeStores.admissionStore.readBufferedRelease({
                trackKey: toALOrderingTrackKey(seq2)!,
                seq: 2,
                nowMs: Date.now()
            })
        ).toBeDefined();
        expect(dispatchedMsgIds).toEqual([]);

        runtime1.dispose();
        const runtime2 = createDefaultInboundRuntime(
            createRetainedInboundStoreSet(stores),
            dispatchedMsgIds,
            controlMessages
        );

        await runtime2.admitIncomingMessage(seq1, { kind: 'ws-client', peerId: 'peer-1' });

        await expect.poll(() => dispatchedMsgIds).toEqual([seq1.id.msgId, seq2.id.msgId]);
        expect(controlMessages.map((msg) => msg.payload.typeId)).toContain(
            'al.control.nack.v1'
        );
    });

    it('retains immutable message payloads and latest supersedence across outbound restarts', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const sent: OutboundTestPayload[] = [];
        const stores = createRetainedOutboundStoreSet();
        const runtime = createDefaultOutboundRuntime(stores, sent);
        const firstPresence = createPresenceMessage('presence-1', true);
        const [firstEntry] = await enqueueOutboundOrThrow(runtime, firstPresence);
        runtime.dispose();

        const restartedStores = createRetainedOutboundStoreSet(stores);
        const restarted = createDefaultOutboundRuntime(restartedStores, sent);
        vi.setSystemTime(Date.now() + 1);
        const secondPresence = createPresenceMessage('presence-2', false);
        const [secondEntry] = await enqueueOutboundOrThrow(restarted, secondPresence);

        expect(secondEntry.key).not.toEqual(firstEntry.key);
        const admission = restartedStores.runtimeStores.admissionStore;
        expect(await admission.isMessageSuperseded(firstPresence)).toBe(true);
        expect(await admission.isMessageSuperseded(secondPresence)).toBe(false);
        expect((await admission.readSentMessage(firstPresence.id.msgId))?.msg.payload).toEqual(firstPresence.payload);
        expect((await admission.readSentMessage(secondPresence.id.msgId))?.msg.payload).toEqual(secondPresence.payload);
    });

    it('retransmits cached ordered messages after an outbound restart', async () => {
        const sent: OutboundTestPayload[] = [];
        const stores = createRetainedOutboundStoreSet();
        const runtime = createDefaultOutboundRuntime(stores, sent);
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

        await enqueueOutboundOrThrow(runtime, seq1);
        await enqueueOutboundOrThrow(runtime, seq2);

        runtime.dispose();
        const restartedForRepair = createDefaultOutboundRuntime(
            createRetainedOutboundStoreSet(stores),
            sent
        );

        await restartedForRepair.acceptControlMessage(
            newALNackControlMessage(
                { v: 2, msgId: 'control-gap', ts: 1, senderId: 'peer-1' },
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

        expect(sent).toContainEqual({ kind: 'send', msgId: seq1.id.msgId, phase: 'immediate' });
        await expect.poll(() => sent.filter((entry) => entry.msgId === seq1.id.msgId && entry.kind === 'repair' && entry.trigger === 'nack')).toHaveLength(1);
    });

    it('continues pending outbound acknowledgement timers after restart', async () => {
        vi.useFakeTimers();

        const sent: Array<OutboundTestPayload> = [];
        const stores = createRetainedOutboundStoreSet();
        const runtime1 = createDefaultOutboundRuntime(stores, sent);
        const msg = createOutboundMessage('msg-timeout');

        await enqueueOutboundOrThrow(runtime1, msg);
        runtime1.dispose();

        const runtime2 = createDefaultOutboundRuntime(
            createRetainedOutboundStoreSet(stores),
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
        const stores = createRetainedOutboundStoreSet();
        const runtime1 = createDefaultOutboundRuntime(stores, sent);
        const msg = createOutboundMessage('msg-shared-timeout');

        await enqueueOutboundOrThrow(runtime1, msg);

        const runtime2 = createDefaultOutboundRuntime(
            createRetainedOutboundStoreSet(stores),
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

function createRetainedInboundStoreSet(
    existing?: RetainedAdmissionState
): RetainedRuntimeStoreSet<ALInboundRuntimeStores> {
    const admissionState = existing?.admissionState ??
        createInMemoryALAdmissionState();

    const backend = new InMemoryAdmissionBackend(admissionState, Date.now);
    return {
        admissionState,
        runtimeStores: {
            workQueue: backend.workQueue,
            admissionStore: createALInboundAdmissionStore({
                namespace: 'durable-test:inbound:admission',
                backend,
                orderingTrackTtlMs: 5 * 60_000,
                supersedenceTrackTtlMs: 5 * 60_000,
                retention: normalizeALRuntimeStoreRetention()
            })
        }
    };
}

function createDefaultInboundRuntime(
    stores: RetainedRuntimeStoreSet<ALInboundRuntimeStores>,
    dispatchedMsgIds: string[],
    controlMessages: ALMessage[] = []
): ALInboundMessageRuntime {
    const runtime = createDefaultALInboundMessageRuntime({
        selfPeerId: 'self',

        stores: stores.runtimeStores,
        planIncomingMessage: (msg, source, observations) =>
            planALMessageHandling(msg, {
                selfPeerId: 'self',
                fromPeerId: source.kind === 'trusted-server' ? undefined : source.peerId,
                connectedPeerIds: ['peer-1', 'peer-2'],
                groupMemberPeerIds: ['self', 'peer-1', 'peer-2'],
                overlayNeighborPeerIds: ['peer-2'],
                ...observations
            }),
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

function createRetainedOutboundStoreSet(
    existing?: RetainedAdmissionState
): RetainedRuntimeStoreSet<ALOutboundRuntimeStores> {
    const admissionState = existing?.admissionState ??
        createInMemoryALAdmissionState();

    return {
        admissionState,
        runtimeStores: {
            admissionStore: createALOutboundAdmissionStore({
                namespace: 'durable-test:outbound:admission',
                backend: new InMemoryAdmissionBackend(admissionState, Date.now),
                supersedenceTrackTtlMs: 5 * 60_000,
                retention: normalizeALRuntimeStoreRetention()
            })
        }
    };
}

function createDefaultOutboundRuntime(
    stores: RetainedRuntimeStoreSet<ALOutboundRuntimeStores>,
    sent: OutboundTestPayload[]
): ALOutboundMessageRuntime<OutboundTestPayload> {
    const runtime = createDefaultALOutboundMessageRuntime<OutboundTestPayload>({
        outbox: stores.runtimeStores.admissionStore.workQueue,
        stores: stores.runtimeStores,
        toOutboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox'),
        decodePreparedMessage: decodeOutboundTestPayload,
        readMessageFromEntry: (entry) => decodePersistedALMessage(entry.resource),
        planOutgoingMessage: planOutboundTestMessage,
        planRepairMessage: async (msg, request) => ({
            msg: msg,
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

            return { status: 'sent' as const };
        }
    });
    onTestFinished(() => runtime.dispose());
    return runtime;
}

function planOutboundTestMessage(msg: ALMessage): ALOutboundDispatchPlan<OutboundTestPayload> {
    if (msg.payload.typeId === 'presence.state.v1') {
        return {
            msg,
            persist: true,
            preparedMessages: [],
            supersedenceTracking: { enabled: true, algo: 'latest-wins', key: `presence:${msg.route.contextId}` }
        };
    }
    return {
        msg,
        persist: false,
        preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
        ackTracking: { enabled: true, timeoutMs: 100, maxAttempts: 1, expectedPeerIds: ['peer-1'] },
        repairTracking: { enabled: true, algo: 'retransmit', maxAttempts: 1 }
    };
}

function createPresenceMessage(resourceId: string, online: boolean): ALMessage {
    return newALUnicastMessage(
        'self',
        { topicId: 'presence', resourceId, contextId: 'room-1' },
        'peer-1',
        'presence.state.v1',
        { online },
        { ttlMs: 30_000 }
    );
}

function createBufferedOrderedMessage(seq: number, text: string): ALMessage {
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
            ttlMs: 30_000,
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

function createOutboundMessage(resourceId: string): ALMessage {
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
        },
        { ttlMs: 30_000 }
    );
}

function groupRef(groupId: string): GroupRef {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId
    };
}
