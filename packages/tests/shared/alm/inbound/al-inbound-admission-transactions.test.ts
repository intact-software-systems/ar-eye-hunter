import '../../../setup-browser-indexeddb.ts';

import {
    afterEach,
    expect,
    it,
    vi
} from 'vitest';

import { createTestALInboundControlAdmission } from '@shared-test/shared/create-test-al-inbound-work-port.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import type { ALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

import {
    computeInboundTestAdmission,
    createInboundTestMessage,
    createInboundTestStores,
    INBOUND_TEST_SOURCE,
    readInboundTestDecisionSurface
} from '../inbound-runtime-test-fixture.ts';
import { recordIndexedDbTransactions } from '../record-indexed-db-transactions.ts';

afterEach(() => {
    vi.restoreAllMocks();
});

const TRANSACTION_NAMESPACE = 'inbound-admission-transactions';
const SUPERSEDENCE_KEY = 'shared-topic';
const ACKNOWLEDGING_PEER_ID = 'downstream';

/** One readonly session per decision surface: what Tasks 1-3 owe every read below. */
const ONE_DECISION_SURFACE: readonly IDBTransactionMode[] = ['readonly'];

/**
 * What a control admission that reaches its commit owes: one decision surface, the write phase's own
 * fence snapshot, then the conditional write. The fence re-read is not a duplicate of the surface --
 * it has to observe a store state later than the one it fences, so it can see a commit in between.
 */
const COMMITTING_CONTROL_ADMISSION: readonly IDBTransactionMode[] = ['readonly', 'readonly', 'readwrite'];

async function createAdmissionFixture(): Promise<ALInboundRuntimeStores> {
    const stores = createInboundTestStores({
        namespace: TRANSACTION_NAMESPACE,
        storage: 'indexeddb',
        observer: createPassThroughIndexedDbOperationObserver()
    });
    // Opening the database is the fixture's cost, never the read chain's.
    await stores.admissionStore.ready();
    return stores;
}

async function admitIncomingMessage(admissionStore: ALInboundAdmissionStore, msg: ALMessage): Promise<void> {
    expect(await admissionStore.commitBundle(await computeInboundTestAdmission(admissionStore, msg))).toBe('committed');
}

/** Two messages past the gap the track opens at seq 1: both are buffered, neither is released. */
async function bufferTwoOrderedMessages(admissionStore: ALInboundAdmissionStore): Promise<void> {
    await admitIncomingMessage(admissionStore, createInboundTestMessage({ msgId: 'buffered-2', seq: 2 }));
    await admitIncomingMessage(admissionStore, createInboundTestMessage({ msgId: 'buffered-3', seq: 3 }));
}

function createOrderedIngressMessage(): ALMessage {
    return createInboundTestMessage({ msgId: 'ordered-ingress', seq: 4, supersedenceKey: SUPERSEDENCE_KEY });
}

/** A committed message whose downstream peer still owes an acknowledgement: what a control reads. */
async function seedAcknowledgeableMessage(admissionStore: ALInboundAdmissionStore): Promise<ALMessage> {
    const message = createInboundTestMessage({ msgId: 'control-transactions' });
    const expireAtTimestamp = Date.now() + 60_000;
    const read = await readInboundTestDecisionSurface(admissionStore, message);
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
                    source: INBOUND_TEST_SOURCE,
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
                        toPeerId: message.id.senderId,
                        status: 'subtree-complete',
                        localReady: true,
                        expectedFromPeerIds: [ACKNOWLEDGING_PEER_ID],
                        ackedFromPeerIds: [],
                        expireAtTimestamp
                    }
                },
                expireAtTimestamp
            }, {
                kind: 'set-control-owners',
                msgId: message.id.msgId,
                value: {
                    ambiguous: false,
                    values: [{ peerId: ACKNOWLEDGING_PEER_ID, senderId: message.id.senderId }]
                },
                expireAtTimestamp
            }],
            durableEffects: []
        })
    ).toBe('committed');
    return message;
}

function newAcknowledgement(message: ALMessage): ALMessage {
    return newALAckControlMessage(
        { v: 2, msgId: `${message.id.msgId}-ack`, senderId: ACKNOWLEDGING_PEER_ID, ts: Date.now() },
        {
            fromPeerId: ACKNOWLEDGING_PEER_ID,
            toPeerId: message.id.senderId,
            ackedMsgId: message.id.msgId,
            status: 'delivered',
            observedAtEpochMs: Date.now()
        }
    );
}

it.fails('reads a first inbound decision surface in 1 readonly transaction, not the 5 it opens today', async () => {
    const { admissionStore } = await createAdmissionFixture();

    const recorded = recordIndexedDbTransactions();
    await readInboundTestDecisionSurface(admissionStore, createInboundTestMessage({ msgId: 'first-ingress' }));

    expect(recorded.modes(), 'readIncomingMessage, first ingress: 5 transactions today').toEqual(ONE_DECISION_SURFACE);
});

it('reads both buffered rows and the supersedence pair of an ordered, tracked surface', async () => {
    const { admissionStore } = await createAdmissionFixture();
    await bufferTwoOrderedMessages(admissionStore);

    const read = await readInboundTestDecisionSurface(admissionStore, createOrderedIngressMessage());

    // Every dependent hop the pin below counts ran: the track carries both buffered rows, each with
    // its own canonical message, and the supersedence pair is read for the key the plan named.
    expect(read.observations.ordering?.buffered.map((entry) => entry.seq)).toEqual([2, 3]);
    expect(read.supersedence.key).toBe(SUPERSEDENCE_KEY);
});

it.fails('reads an ordered, supersedence-tracked surface in 1 readonly transaction, not the 12 it opens today', async () => {
    const { admissionStore } = await createAdmissionFixture();
    await bufferTwoOrderedMessages(admissionStore);

    const recorded = recordIndexedDbTransactions();
    await readInboundTestDecisionSurface(admissionStore, createOrderedIngressMessage());

    expect(recorded.modes(), 'readIncomingMessage, ordered and tracked: 12 transactions today, 10 plus one per buffered row')
        .toEqual(ONE_DECISION_SURFACE);
});

it('reads the buffered message a release surface is asked for', async () => {
    const { admissionStore } = await createAdmissionFixture();
    await bufferTwoOrderedMessages(admissionStore);

    const read = await admissionStore.readBufferedRelease({
        trackKey: toALOrderingTrackKey(createInboundTestMessage({ msgId: 'buffered-2', seq: 2 }))!,
        seq: 2,
        nowMs: Date.now()
    });

    expect(read?.snapshot.msg.id.msgId).toBe('buffered-2');
});

it.fails('reads a buffered release surface in 1 readonly transaction, not the 7 it opens today', async () => {
    const { admissionStore } = await createAdmissionFixture();
    await bufferTwoOrderedMessages(admissionStore);
    const trackKey = toALOrderingTrackKey(createInboundTestMessage({ msgId: 'buffered-2', seq: 2 }))!;

    const recorded = recordIndexedDbTransactions();
    await admissionStore.readBufferedRelease({ trackKey, seq: 2, nowMs: Date.now() });

    expect(recorded.modes(), 'readBufferedRelease: 7 transactions today').toEqual(ONE_DECISION_SURFACE);
});

it('reads the supersedence key an admitted message was stored under', async () => {
    const { admissionStore } = await createAdmissionFixture();
    const message = createInboundTestMessage({ msgId: 'stored-planning', supersedenceKey: SUPERSEDENCE_KEY });
    await admitIncomingMessage(admissionStore, message);

    const read = await admissionStore.readStoredPlanningState({ msg: message, nowMs: Date.now() });

    expect(read.supersedenceKey).toBe(SUPERSEDENCE_KEY);
});

it.fails('reads a stored planning surface in 1 readonly transaction, not the 3 it opens today', async () => {
    const { admissionStore } = await createAdmissionFixture();
    const message = createInboundTestMessage({ msgId: 'stored-planning', supersedenceKey: SUPERSEDENCE_KEY });
    await admitIncomingMessage(admissionStore, message);

    const recorded = recordIndexedDbTransactions();
    await admissionStore.readStoredPlanningState({ msg: message, nowMs: Date.now() });

    expect(recorded.modes(), 'readStoredPlanningState: 3 transactions today').toEqual(ONE_DECISION_SURFACE);
});

it('commits the acknowledgement its control owner index resolves to a tracked message', async () => {
    const stores = await createAdmissionFixture();
    const message = await seedAcknowledgeableMessage(stores.admissionStore);
    const control = createTestALInboundControlAdmission({ ...stores, nowMs: Date.now, newControlId: () => 'control' });

    expect((await control.admit(newAcknowledgement(message))).kind).toBe('committed');
});

it.fails('admits a control message in 1 surface, 1 fence and 1 write, not the 6 transactions today', async () => {
    const stores = await createAdmissionFixture();
    const message = await seedAcknowledgeableMessage(stores.admissionStore);
    const control = createTestALInboundControlAdmission({ ...stores, nowMs: Date.now, newControlId: () => 'control' });
    const ack = newAcknowledgement(message);

    const recorded = recordIndexedDbTransactions();
    await control.admit(ack);

    expect(recorded.modes(), 'readControlAdmission: 6 transactions today, 4 of them the decision surface')
        .toEqual(COMMITTING_CONTROL_ADMISSION);
});

it('commits one bundle with one fence snapshot and one write, neither queued behind the other', async () => {
    const { admissionStore } = await createAdmissionFixture();
    const bundle = await computeInboundTestAdmission(
        admissionStore,
        createInboundTestMessage({ msgId: 'commit-bundle' })
    );

    const recorded = recordIndexedDbTransactions();
    expect(await admissionStore.commitBundle(bundle)).toBe('committed');

    // Each one starts on an unlocked store: the fence snapshot is closed before the conditional
    // write is created, so the readwrite never queues behind an idle readonly.
    expect(recorded.liveWhenOpened()).toEqual([0, 0]);
});
