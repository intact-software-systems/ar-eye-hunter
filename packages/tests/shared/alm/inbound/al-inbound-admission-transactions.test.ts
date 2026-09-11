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
import type { ALInboundMessageAdmission } from '@shared/alm/inbound/al-inbound-message-admission.ts';
import type { ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALInboundPendingAdmission } from '@shared/alm/inbound/al-inbound-pending-admission.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

import {
    createInboundTestDispatch,
    readInboundTestDispatchEffect
} from '../create-inbound-test-dispatch.ts';
import {
    createInboundTestAdmission,
    createInboundTestMessage,
    createInboundTestStores,
    INBOUND_TEST_SOURCE,
    planInboundTestMessage,
    readInboundTestAdmission,
    readInboundTestDecisionSurface,
    setNextInboundCommitConflicted
} from '../inbound-runtime-test-fixture.ts';
import { recordIndexedDbTransactions } from '../record-indexed-db-transactions.ts';

afterEach(() => {
    vi.restoreAllMocks();
});

const TRANSACTION_NAMESPACE = 'inbound-admission-transactions';
const SUPERSEDENCE_KEY = 'shared-topic';
const ACKNOWLEDGING_PEER_ID = 'downstream';

/**
 * One readonly session per decision surface. Each surface below opened between 3 and 12 transactions
 * before the inbound owner read its whole chain from one session; that is what these pins guard.
 */
const ONE_DECISION_SURFACE: readonly IDBTransactionMode[] = ['readonly'];

/**
 * What a control admission that reaches its commit owes: one decision surface, the write phase's own
 * fence snapshot, then the conditional write. The fence re-read is not a duplicate of the surface --
 * it has to observe a store state later than the one it fences, so it can see a commit in between.
 */
const COMMITTING_CONTROL_ADMISSION: readonly IDBTransactionMode[] = ['readonly', 'readonly', 'readwrite'];

/**
 * What a data admission that reaches its commit owes: the one decision surface `attempt` reads, the
 * write phase's own fence snapshot, then the conditional write.
 */
const COMMITTING_ADMISSION_ATTEMPT: readonly IDBTransactionMode[] = ['readonly', 'readonly', 'readwrite'];

/**
 * What the second phase of a conflicted admission costs today: the retained row's own absence guard
 * and the row itself, then a whole second attempt.
 *
 * The conclusion this measurement was written to reach: a conflict means at least one
 * authority-bearing observation moved, so everything the fence compares -- message owner, dedup,
 * ordering snapshot, supersedence pair, delivery progress, acks, control owners -- has to be read
 * again, and the replay's decision surface stays. What the replay repeats beyond that is immutable
 * and already carried: `retainPending` persists the decoded message with its resolved deadline and
 * the validated source, and re-deriving the pre-plan, the deadline and the effect facts from them
 * opens no transaction. Carrying them in the retained payload would therefore save no storage, so
 * the persisted contract is left as it stands and this pin is the whole of the second phase's cost.
 */
const RETAIN_THEN_REPLAY: readonly IDBTransactionMode[] = [
    'readonly',
    'readwrite',
    ...COMMITTING_ADMISSION_ATTEMPT
];

/**
 * What one unordered `dispatch-local` row owes from the readiness read that clears it to the page
 * it reaches: the one retained message and the one stored planning surface both of them decide on.
 * The claim the rotation takes between them is the only thing that ever separated the two.
 */
const ONE_DISPATCHED_MESSAGE: readonly IDBTransactionMode[] = ['readonly', 'readonly'];

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
    expect(await admissionStore.commitBundle(await readInboundTestAdmission(admissionStore, msg))).toBe('committed');
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

/** Lands the competing row an attempt then loses to, and returns the pending value it left behind. */
async function writeConflictedPendingAdmission(
    admission: ALInboundMessageAdmission,
    admissionStore: ALInboundAdmissionStore,
    msg: ALMessage
): Promise<ALInboundPendingAdmission> {
    setNextInboundCommitConflicted(admissionStore);
    const attempt = await admission.attempt(msg, INBOUND_TEST_SOURCE, planInboundTestMessage);
    const conflicted = attempt.right;
    if (conflicted?.kind !== 'conflict' || conflicted.pending === undefined) {
        throw new Error('Expected the competing writer to force a retained conflict');
    }
    return conflicted.pending;
}

it('reads a first inbound decision surface in 1 readonly transaction', async () => {
    const { admissionStore } = await createAdmissionFixture();

    const recorded = recordIndexedDbTransactions();
    await readInboundTestDecisionSurface(admissionStore, createInboundTestMessage({ msgId: 'first-ingress' }));

    expect(recorded.modes(), 'readIncomingMessage, first ingress').toEqual(ONE_DECISION_SURFACE);
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

it('reads an ordered, supersedence-tracked surface in 1 readonly transaction', async () => {
    const { admissionStore } = await createAdmissionFixture();
    await bufferTwoOrderedMessages(admissionStore);

    const recorded = recordIndexedDbTransactions();
    await readInboundTestDecisionSurface(admissionStore, createOrderedIngressMessage());

    expect(recorded.modes(), 'readIncomingMessage, ordered and tracked').toEqual(ONE_DECISION_SURFACE);
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

it('reads a buffered release surface in 1 readonly transaction', async () => {
    const { admissionStore } = await createAdmissionFixture();
    await bufferTwoOrderedMessages(admissionStore);
    const trackKey = toALOrderingTrackKey(createInboundTestMessage({ msgId: 'buffered-2', seq: 2 }))!;

    const recorded = recordIndexedDbTransactions();
    await admissionStore.readBufferedRelease({ trackKey, seq: 2, nowMs: Date.now() });

    expect(recorded.modes(), 'readBufferedRelease').toEqual(ONE_DECISION_SURFACE);
});

it('reads the supersedence key an admitted message was stored under', async () => {
    const { admissionStore } = await createAdmissionFixture();
    const message = createInboundTestMessage({ msgId: 'stored-planning', supersedenceKey: SUPERSEDENCE_KEY });
    await admitIncomingMessage(admissionStore, message);

    const read = await admissionStore.readStoredPlanningState({ msg: message, nowMs: Date.now() });

    expect(read.supersedenceKey).toBe(SUPERSEDENCE_KEY);
});

it('reads a stored planning surface in 1 readonly transaction', async () => {
    const { admissionStore } = await createAdmissionFixture();
    const message = createInboundTestMessage({ msgId: 'stored-planning', supersedenceKey: SUPERSEDENCE_KEY });
    await admitIncomingMessage(admissionStore, message);

    const recorded = recordIndexedDbTransactions();
    await admissionStore.readStoredPlanningState({ msg: message, nowMs: Date.now() });

    expect(recorded.modes(), 'readStoredPlanningState').toEqual(ONE_DECISION_SURFACE);
});

it('commits the acknowledgement its control owner index resolves to a tracked message', async () => {
    const stores = await createAdmissionFixture();
    const message = await seedAcknowledgeableMessage(stores.admissionStore);
    const control = createTestALInboundControlAdmission({ ...stores, nowMs: Date.now, newControlId: () => 'control' });

    expect((await control.admit(newAcknowledgement(message))).kind).toBe('committed');
});

it('admits a control message in 1 surface, 1 fence and 1 write', async () => {
    const stores = await createAdmissionFixture();
    const message = await seedAcknowledgeableMessage(stores.admissionStore);
    const control = createTestALInboundControlAdmission({ ...stores, nowMs: Date.now, newControlId: () => 'control' });
    const ack = newAcknowledgement(message);

    const recorded = recordIndexedDbTransactions();
    await control.admit(ack);

    expect(recorded.modes(), 'ALInboundControlAdmission.admit').toEqual(COMMITTING_CONTROL_ADMISSION);
});

it('commits one bundle with one fence snapshot and one write, neither queued behind the other', async () => {
    const { admissionStore } = await createAdmissionFixture();
    const bundle = await readInboundTestAdmission(
        admissionStore,
        createInboundTestMessage({ msgId: 'commit-bundle' })
    );

    const recorded = recordIndexedDbTransactions();
    expect(await admissionStore.commitBundle(bundle)).toBe('committed');

    // Each one starts on an unlocked store: the fence snapshot is closed before the conditional
    // write is created, so the readwrite never queues behind an idle readonly.
    expect(recorded.liveWhenOpened()).toEqual([0, 0]);
});

it('admits one message in 1 surface, 1 fence and 1 write', async () => {
    const admission = createInboundTestAdmission(await createAdmissionFixture());
    const msg = createInboundTestMessage({ msgId: 'single-attempt' });

    const recorded = recordIndexedDbTransactions();
    await admission.attempt(msg, INBOUND_TEST_SOURCE, planInboundTestMessage);

    expect(recorded.modes(), 'ALInboundMessageAdmission.attempt').toEqual(COMMITTING_ADMISSION_ATTEMPT);
});

it('retains a conflicted admission and replays it to completion', async () => {
    const stores = await createAdmissionFixture();
    const admission = createInboundTestAdmission(stores);
    const pending = await writeConflictedPendingAdmission(
        admission,
        stores.admissionStore,
        createInboundTestMessage({ msgId: 'conflicted-replay' })
    );

    expect(await admission.retainPending(pending)).toEqual({ kind: 'pending-admission' });
    // The replay's own commit wrote the dispatch its batch's page read could not see.
    expect(await admission.replay(pending)).toEqual({ outcome: 'completed', wroteWork: true });
});

it('retains and replays a conflicted admission in 1 guarded row and 1 second attempt', async () => {
    const stores = await createAdmissionFixture();
    const admission = createInboundTestAdmission(stores);
    const pending = await writeConflictedPendingAdmission(
        admission,
        stores.admissionStore,
        createInboundTestMessage({ msgId: 'conflicted-cost' })
    );

    const recorded = recordIndexedDbTransactions();
    await admission.retainPending(pending);
    // Inside the measured window, and opening nothing: the count below is a successful replay's.
    expect(await admission.replay(pending), 'the measured replay').toEqual({ outcome: 'completed', wroteWork: true });

    expect(recorded.modes(), 'retainPending then replay').toEqual(RETAIN_THEN_REPLAY);
});

it('dispatches the unordered row its readiness read cleared', async () => {
    const stores = await createAdmissionFixture();
    const dispatch = createInboundTestDispatch(stores);
    const effect = await readInboundTestDispatchEffect(
        stores,
        createInboundTestMessage({ msgId: 'ready-then-dispatched' })
    );

    const readiness = await dispatch.delivery.readReadiness(effect, Date.now());

    expect(readiness.ready).toBe(true);
    expect(await dispatch.delivery.deliver(effect, readiness.observed)).toBe('completed');
    expect(dispatch.dispatched).toEqual(['ready-then-dispatched']);
});

it('reads one message and one planning surface from readiness through dispatch', async () => {
    const stores = await createAdmissionFixture();
    const dispatch = createInboundTestDispatch(stores);
    const effect = await readInboundTestDispatchEffect(stores, createInboundTestMessage({ msgId: 'dispatch-cost' }));

    const recorded = recordIndexedDbTransactions();
    const readiness = await dispatch.delivery.readReadiness(effect, Date.now());
    await dispatch.delivery.deliver(effect, readiness.observed);

    expect(recorded.modes(), 'readReadiness then deliver').toEqual(ONE_DISPATCHED_MESSAGE);
});

it('reads the ordering track again at the dispatch its readiness read already cleared', async () => {
    const stores = await createAdmissionFixture();
    const dispatch = createInboundTestDispatch(stores);
    const message = createInboundTestMessage({ msgId: 'ordered-dispatch', seq: 1 });
    const effect = await readInboundTestDispatchEffect(stores, message);
    const readiness = await dispatch.delivery.readReadiness(effect, Date.now());
    expect(await dispatch.delivery.deliver(effect, readiness.observed)).toBe('completed');

    // The first delivery moved the track this observation was read against, which is exactly what a
    // predecessor landing inside a claim window does. A dispatch that trusted the carried readiness
    // would hand the page a second copy.
    expect(await dispatch.delivery.deliver(effect, readiness.observed)).toBe('completed');

    expect(dispatch.dispatched).toEqual(['ordered-dispatch']);
});
