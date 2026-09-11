import '../../../setup-browser-indexeddb.ts';

import {
    afterEach,
    expect,
    it,
    vi
} from 'vitest';

import { createTestALInboundControlAdmission } from '@shared-test/shared/create-test-al-inbound-work-port.ts';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { computeALInboundAdmission } from '@shared/alm/inbound/admission/compute-al-inbound-admission.ts';
import {
    createALInboundAdmissionStore,
    type ALInboundAdmissionStore,
    type ALInboundCommitBundle
} from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { computeALInboundPlanningObservations } from '@shared/alm/inbound/al-inbound-planner-snapshot.ts';
import { readALInboundEffectFacts } from '@shared/alm/inbound/prepare-al-inbound-commit-bundle.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-database.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import { recordIndexedDbTransactions } from '../record-indexed-db-transactions.ts';

afterEach(() => {
    vi.restoreAllMocks();
});

const TRANSACTION_NAMESPACE = 'inbound-admission-transactions';
const SELF_PEER_ID = 'receiver';
const SENDER_PEER_ID = 'sender';
const ORDERING_KEY = 'chat';

/** One readonly session per decision surface: what Tasks 1-3 owe every read below. */
const ONE_DECISION_SURFACE: readonly IDBTransactionMode[] = ['readonly'];

/**
 * What a control admission that reaches its commit owes: one decision surface, the write phase's own
 * fence snapshot, then the conditional write. The fence re-read is not a duplicate of the surface --
 * it has to observe a store state later than the one it fences, so it can see a commit in between.
 */
const COMMITTING_CONTROL_ADMISSION: readonly IDBTransactionMode[] = ['readonly', 'readonly', 'readwrite'];

interface InboundAdmissionFixture {
    readonly admissionStore: ALInboundAdmissionStore;
    readonly backend: IndexedDbAdmissionBackend;
}

async function createAdmissionFixture(name: string): Promise<InboundAdmissionFixture> {
    const backend = new IndexedDbAdmissionBackend({
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {},
        dbName: `${TRANSACTION_NAMESPACE}-${name}-${crypto.randomUUID()}`,
        storeName: 'entries',
        nowMs: Date.now,
        newWriteToken: crypto.randomUUID.bind(crypto),
        observer: createPassThroughIndexedDbOperationObserver()
    });
    const admissionStore = createALInboundAdmissionStore({
        nowMs: Date.now,
        namespace: TRANSACTION_NAMESPACE,
        backend,
        orderingTrackTtlMs: 60_000,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    // Opening the database is the fixture's cost, never the read chain's.
    await admissionStore.ready();
    return { admissionStore, backend };
}

interface IncomingMessageInput {
    readonly msgId: string;
    readonly seq?: number;
    readonly supersedenceKey?: string;
}

function createIncomingMessage(input: IncomingMessageInput): ALMessage {
    const message = newALUnicastMessage(
        SENDER_PEER_ID,
        { topicId: ORDERING_KEY, resourceId: input.msgId, contextId: 'room' },
        SELF_PEER_ID,
        'chat.private-text.v1',
        { text: input.msgId },
        {
            ttlMs: 60_000,
            qos: input.supersedenceKey === undefined ? undefined : {
                supersedence: { algo: 'latest-wins', opts: { supersedenceKey: input.supersedenceKey } }
            }
        }
    );
    return {
        ...message,
        id: { ...message.id, msgId: input.msgId },
        ordering: input.seq === undefined ? undefined : { orderingKey: ORDERING_KEY, seq: input.seq }
    };
}

async function readIncomingDecisionSurface(admissionStore: ALInboundAdmissionStore, msg: ALMessage) {
    const nowMs = Date.now();
    const context = { selfPeerId: SELF_PEER_ID, fromPeerId: SENDER_PEER_ID, nowMs };
    return await admissionStore.readIncomingMessage({
        msg,
        source: { kind: 'ws-client', peerId: SENDER_PEER_ID },
        nowMs,
        prePlan: planALMessageHandling(msg, context)
    });
}

/** The real compute path's own bundle, so every row an admission leaves behind is a real one. */
async function computeInboundTestAdmission(
    admissionStore: ALInboundAdmissionStore,
    msg: ALMessage
): Promise<ALInboundCommitBundle> {
    const nowMs = Date.now();
    const context = { selfPeerId: SELF_PEER_ID, fromPeerId: SENDER_PEER_ID, nowMs };
    const read = await readIncomingDecisionSurface(admissionStore, msg);
    const plan = planALMessageHandling(msg, { ...context, ...computeALInboundPlanningObservations(read) });
    const facts = readALInboundEffectFacts(nowMs, {
        newControlId: crypto.randomUUID.bind(crypto),
        selfPeerId: SELF_PEER_ID,
        createInboxEntry: (incoming) => QueueBoxUtilities.toResourceEntryFromMsg(incoming, 'inbox')
    });
    return computeALInboundAdmission({ read, plan, facts, canForward: false });
}

async function admitIncomingMessage(admissionStore: ALInboundAdmissionStore, msg: ALMessage): Promise<void> {
    expect(await admissionStore.commitBundle(await computeInboundTestAdmission(admissionStore, msg))).toBe('committed');
}

/** Two messages past the gap the track opens at seq 1: both are buffered, neither is released. */
async function bufferTwoOrderedMessages(admissionStore: ALInboundAdmissionStore): Promise<void> {
    await admitIncomingMessage(admissionStore, createIncomingMessage({ msgId: 'buffered-2', seq: 2 }));
    await admitIncomingMessage(admissionStore, createIncomingMessage({ msgId: 'buffered-3', seq: 3 }));
}

/** A committed message whose downstream peer still owes an acknowledgement: what a control reads. */
async function seedAcknowledgeableMessage(admissionStore: ALInboundAdmissionStore): Promise<ALMessage> {
    const message = createIncomingMessage({ msgId: 'control-transactions' });
    const expireAtTimestamp = Date.now() + 60_000;
    const read = await readIncomingDecisionSurface(admissionStore, message);
    expect(
        await admissionStore.commitBundle({
            admissionExpiresAtMs: null,
            senderId: message.id.senderId,
            observations: read.observations,
            mutations: [{
                kind: 'set-msg-owner',
                value: {
                    msgId: message.id.msgId,
                    senderId: message.id.senderId,
                    source: { kind: 'ws-client', peerId: SENDER_PEER_ID },
                    supersedenceKey: null
                },
                expireAtTimestamp
            }, {
                kind: 'set-control-pending',
                msgId: message.id.msgId,
                senderId: message.id.senderId,
                value: {
                    kind: 'pending',
                    value: {
                        toPeerId: SENDER_PEER_ID,
                        status: 'subtree-complete',
                        localReady: true,
                        expectedFromPeerIds: ['downstream'],
                        ackedFromPeerIds: [],
                        expireAtTimestamp
                    }
                },
                expireAtTimestamp
            }, {
                kind: 'set-control-owners',
                msgId: message.id.msgId,
                value: { ambiguous: false, values: [{ peerId: 'downstream', senderId: message.id.senderId }] },
                expireAtTimestamp
            }],
            durableEffects: []
        })
    ).toBe('committed');
    return message;
}

it.fails('reads a first inbound decision surface in 1 readonly transaction, not the 5 it opens today', async () => {
    const { admissionStore } = await createAdmissionFixture('first-ingress');

    const recorded = recordIndexedDbTransactions();
    await readIncomingDecisionSurface(admissionStore, createIncomingMessage({ msgId: 'first-ingress' }));

    expect(recorded.modes(), 'readIncomingMessage, first ingress: 5 transactions today').toEqual(ONE_DECISION_SURFACE);
});

it.fails('reads an ordered, supersedence-tracked surface in 1 readonly transaction, not the 12 it opens today', async () => {
    const { admissionStore } = await createAdmissionFixture('ordered-ingress');
    await bufferTwoOrderedMessages(admissionStore);
    const message = createIncomingMessage({ msgId: 'ordered-ingress', seq: 4, supersedenceKey: 'shared-topic' });

    const recorded = recordIndexedDbTransactions();
    const read = await readIncomingDecisionSurface(admissionStore, message);

    // Every dependent hop ran: the track carries both buffered rows and their canonical messages.
    expect(read.observations.ordering?.buffered.map((entry) => entry.seq)).toEqual([2, 3]);
    expect(read.supersedence.key).toBe('shared-topic');
    expect(recorded.modes(), 'readIncomingMessage, ordered and tracked: 12 transactions today, 10 plus one per buffered row')
        .toEqual(ONE_DECISION_SURFACE);
});

it.fails('reads a buffered release surface in 1 readonly transaction, not the 7 it opens today', async () => {
    const { admissionStore } = await createAdmissionFixture('buffered-release');
    await bufferTwoOrderedMessages(admissionStore);
    const trackKey = toALOrderingTrackKey(createIncomingMessage({ msgId: 'buffered-2', seq: 2 }))!;

    const recorded = recordIndexedDbTransactions();
    const read = await admissionStore.readBufferedRelease({ trackKey, seq: 2, nowMs: Date.now() });

    expect(read?.snapshot.msg.id.msgId).toBe('buffered-2');
    expect(recorded.modes(), 'readBufferedRelease: 7 transactions today').toEqual(ONE_DECISION_SURFACE);
});

it.fails('reads a stored planning surface in 1 readonly transaction, not the 3 it opens today', async () => {
    const { admissionStore } = await createAdmissionFixture('stored-planning');
    const message = createIncomingMessage({ msgId: 'stored-planning', supersedenceKey: 'shared-topic' });
    await admitIncomingMessage(admissionStore, message);

    const recorded = recordIndexedDbTransactions();
    const read = await admissionStore.readStoredPlanningState({ msg: message, nowMs: Date.now() });

    expect(read.supersedenceKey).toBe('shared-topic');
    expect(recorded.modes(), 'readStoredPlanningState: 3 transactions today').toEqual(ONE_DECISION_SURFACE);
});

it.fails('admits a control message in 1 surface, 1 fence and 1 write, not the 6 transactions today', async () => {
    const { admissionStore, backend } = await createAdmissionFixture('control');
    const message = await seedAcknowledgeableMessage(admissionStore);
    const control = createTestALInboundControlAdmission({
        admissionStore,
        workQueue: backend.workQueue,
        nowMs: Date.now,
        newControlId: () => 'generated-control'
    });
    const ack = newALAckControlMessage(
        { v: 2, msgId: `${message.id.msgId}-ack`, senderId: 'downstream', ts: Date.now() },
        {
            fromPeerId: 'downstream',
            toPeerId: message.id.senderId,
            ackedMsgId: message.id.msgId,
            status: 'delivered',
            observedAtEpochMs: Date.now()
        }
    );

    const recorded = recordIndexedDbTransactions();
    expect((await control.admit(ack)).kind).toBe('committed');

    expect(recorded.modes(), 'readControlAdmission: 6 transactions today, 4 of them the decision surface')
        .toEqual(COMMITTING_CONTROL_ADMISSION);
});

it('commits one bundle with one fence snapshot and one write, neither queued behind the other', async () => {
    const { admissionStore } = await createAdmissionFixture('commit-bundle');
    const bundle = await computeInboundTestAdmission(admissionStore, createIncomingMessage({ msgId: 'commit-bundle' }));

    const recorded = recordIndexedDbTransactions();
    expect(await admissionStore.commitBundle(bundle)).toBe('committed');

    // Each one starts on an unlocked store: the fence snapshot is closed before the conditional
    // write is created, so the readwrite never queues behind an idle readonly.
    expect(recorded.liveWhenOpened()).toEqual([0, 0]);
});
