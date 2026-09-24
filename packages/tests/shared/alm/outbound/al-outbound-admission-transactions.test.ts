import '../../../setup-browser-indexeddb.ts';

import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { createTestALOutboundControlAdmission } from '@shared-test/shared/create-test-al-outbound-work-port.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import type { ALAdmissionWorkBackend } from '@shared/alm/al-admission-work-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-database.ts';
import {
    createALOutboundAdmissionStore,
    type ALOutboundAdmissionStore,
    type ALOutboundPlanner
} from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type { ALOutboundMessageRuntime } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { toResourceEntryWithKey } from '@shared/queuebox/ResourceEntry.ts';

import {
    computeOutboundTestAdmission,
    createDefaultOutboundTestRuntime,
    createOutboundMessage
} from '../outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from '../outbound-test-payload.ts';
import { recordIndexedDbTransactions } from '../record-indexed-db-transactions.ts';

afterEach(() => {
    vi.restoreAllMocks();
});

const TRANSACTION_NAMESPACE = 'admission-transactions';
/** Longer than a few engine passes at their 100 ms delay, and far inside the 3 s readiness memory. */
const IDLE_OWNER_SETTLE_MS = 300;

/** Tracks the supersedence pair, so a re-admission walks both of its dependent read hops. */
const SUPERSEDING_PLANNER: ALOutboundPlanner<OutboundTestPayload> = (msg) => ({
    msg,
    dropReasonCode: undefined,
    persist: true,
    preparedMessages: [{ text: msg.id.msgId }],
    supersedenceTracking: { enabled: true, algo: 'latest-wins', key: 'shared-topic' }
});

const SEND_PLANNER: ALOutboundPlanner<OutboundTestPayload> = (msg) => ({
    msg,
    dropReasonCode: undefined,
    persist: true,
    preparedMessages: [{ text: msg.id.msgId }]
});

/** Stamps the deadline the QoS normalization of a transport gives a control message, as the planners of both carriers do. */
const CONTROL_PLANNER: ALOutboundPlanner<OutboundTestPayload> = (msg) => ({
    msg: { ...msg, constraints: { ...msg.constraints, expiresAtMs: msg.id.ts + 30_000 } },
    dropReasonCode: undefined,
    persist: true,
    preparedMessages: [{ text: msg.id.msgId }]
});

/** Rewrites the route of `bad-ack` only, which the admission read refuses as a changed authority. */
const AUTHORITY_BREAKING_PLANNER: ALOutboundPlanner<OutboundTestPayload> = (msg) => {
    const plan = CONTROL_PLANNER(msg);
    return msg.id.msgId === 'bad-ack'
        ? { ...plan, msg: { ...plan.msg, route: { ...plan.msg.route, topicId: 'rewritten' } } }
        : plan;
};

/**
 * What an admission that reaches its commit costs: the decision surface, then the write phase's own
 * snapshot, then the conditional write. The second readonly is not a duplicate of the first — a
 * fence re-read has to observe a store state later than the surface it is fencing, so it can see a
 * commit that landed in between.
 */
const COMMITTING_ADMISSION_TRANSACTIONS: readonly IDBTransactionMode[] = ['readonly', 'readonly', 'readwrite'];

interface AdmissionTransactionFixture {
    readonly store: ALOutboundAdmissionStore<OutboundTestPayload>;
    readonly backend: IndexedDbAdmissionBackend;
}

async function createAdmissionFixture(name: string): Promise<AdmissionTransactionFixture> {
    const backend = createTransactionBackend(name);
    const store = createTransactionAdmissionStore(backend);
    // Opening the database is the fixture's cost, never the read chain's.
    await store.ready();
    return { store, backend };
}

function createTransactionBackend(name: string): IndexedDbAdmissionBackend {
    return new IndexedDbAdmissionBackend({
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {},
        dbName: `${TRANSACTION_NAMESPACE}-${name}-${crypto.randomUUID()}`,
        storeName: 'entries',
        nowMs: Date.now,
        newWriteToken: crypto.randomUUID.bind(crypto),
        observer: createPassThroughIndexedDbOperationObserver()
    });
}

function createTransactionAdmissionStore(backend: ALAdmissionWorkBackend): ALOutboundAdmissionStore<OutboundTestPayload> {
    return createALOutboundAdmissionStore({
        nowMs: Date.now,
        canonicalScope: TRANSACTION_NAMESPACE,
        decodePrepared: decodeOutboundTestPayload,
        namespace: TRANSACTION_NAMESPACE,
        backend,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
}

async function admitOutboundMessage(
    store: ALOutboundAdmissionStore<OutboundTestPayload>,
    message: ALMessage,
    planner: ALOutboundPlanner<OutboundTestPayload>
): Promise<void> {
    expect(await store.commitBundle(await computeOutboundTestAdmission(store, message, planner))).toBe('committed');
}

/** A committed message whose receiver still owes an acknowledgement: what a control admission reads. */
async function seedAcknowledgeableMessage(
    store: ALOutboundAdmissionStore<OutboundTestPayload>
): Promise<ALMessage> {
    const message = createOutboundMessage('control-transactions');
    const admission = await computeOutboundTestAdmission(store, message, SEND_PLANNER);
    expect(
        await store.commitBundle({
            ...admission,
            mutations: [...admission.mutations, {
                kind: 'set-pending-ack',
                snapshot: {
                    msgId: message.id.msgId,
                    expectedPeerIds: ['peer-1'],
                    ackedPeerIds: [],
                    timeoutMs: 2_000,
                    maxAttempts: 3,
                    attempts: 0,
                    deadlineAtMs: Date.now() + 2_000
                },
                expireAtTimestamp: Date.now() + 30_000
            }]
        })
    ).toBe('committed');
    return message;
}

it('reads a first send decision surface from one readonly transaction', async () => {
    const { store } = await createAdmissionFixture('first-send');
    const message = createOutboundMessage('first-send');

    const recorded = recordIndexedDbTransactions();
    await store.readOutgoingMessage({
        msg: message,
        planner: SEND_PLANNER,
        observedCanonicalEntry: undefined,
        intent: 'enqueue'
    });

    expect(recorded.modes()).toEqual(['readonly']);
});

it('reads a re-admitted supersedence-tracked message from one readonly transaction', async () => {
    const { store } = await createAdmissionFixture('re-admission');
    const message = createOutboundMessage('re-admission');
    await admitOutboundMessage(store, message, SUPERSEDING_PLANNER);

    const recorded = recordIndexedDbTransactions();
    const read = await store.readOutgoingMessage({
        msg: message,
        planner: SUPERSEDING_PLANNER,
        observedCanonicalEntry: undefined,
        intent: 'enqueue'
    });

    // Both dependent hops ran: the canonical key came from the stored reference, the supersedence
    // pair from the plan the canonical message produced.
    expect(read.storedMessage).toBeDefined();
    expect(read.supersedence.key).toBe('shared-topic');
    expect(recorded.modes()).toEqual(['readonly']);
});

it('commits one bundle with one read snapshot, one fence snapshot and one write', async () => {
    const { store } = await createAdmissionFixture('commit-bundle');
    const bundle = await computeOutboundTestAdmission(store, createOutboundMessage('commit-bundle'), SEND_PLANNER);

    const recorded = recordIndexedDbTransactions();
    expect(await store.commitBundle(bundle)).toBe('committed');

    expect(recorded.modes()).toEqual(COMMITTING_ADMISSION_TRANSACTIONS);
    // Each one starts on an unlocked store: the write phase's fence snapshot is closed before the
    // conditional write is created, so the readwrite never queues behind an idle readonly.
    expect(recorded.liveWhenOpened()).toEqual([0, 0, 0]);
});

it('closes the fence snapshot of a commit that conflicts inside its own write phase', async () => {
    const { store } = await createAdmissionFixture('commit-conflict');
    const message = createOutboundMessage('commit-conflict');
    const winner = await computeOutboundTestAdmission(store, message, SEND_PLANNER);
    const stale = await computeOutboundTestAdmission(store, message, SEND_PLANNER);
    expect(await store.commitBundle(winner)).toBe('committed');

    const recorded = recordIndexedDbTransactions();
    // The fence rejects this one inside the write callback, which is the normal conflict path.
    expect(await store.commitBundle(stale)).toBe('conflict');

    expect(recorded.liveCount()).toBe(0);
});

it('reads a repair decision surface from one readonly transaction', async () => {
    const { store } = await createAdmissionFixture('repair');
    const message = createOutboundMessage('repair');
    await admitOutboundMessage(store, message, SEND_PLANNER);

    const recorded = recordIndexedDbTransactions();
    const repair = await store.readRepairMessage(message.id.msgId, SEND_PLANNER);

    expect(repair.sentSnapshot).toBeDefined();
    expect(recorded.modes()).toEqual(['readonly']);
});

it('reads a control decision surface from one readonly transaction before its write', async () => {
    const { store, backend } = await createAdmissionFixture('control');
    const message = await seedAcknowledgeableMessage(store);
    const control = createTestALOutboundControlAdmission({
        admissionStore: store,
        workQueue: backend.workQueue,
        nowMs: Date.now,
        carrier: 'ws'
    });
    const ack = newALAckControlMessage(
        { v: 2, msgId: `${message.id.msgId}-ack`, senderId: 'peer-1', ts: Date.now() },
        {
            fromPeerId: 'peer-1',
            toPeerId: message.id.senderId,
            ackedMsgId: message.id.msgId,
            status: 'delivered',
            observedAtEpochMs: Date.now(),
            carrier: 'ws'
        }
    );

    const recorded = recordIndexedDbTransactions();
    expect((await control.admit(ack)).kind).toBe('committed');

    expect(recorded.modes()).toEqual(COMMITTING_ADMISSION_TRANSACTIONS);
});

it('leaves an expired work row where a session read found it, for the queue sweep to remove', async () => {
    const { backend } = await createAdmissionFixture('expired-work');
    const expired = toResourceEntryWithKey(
        { topicId: 'AL_OUTBOUND', resourceId: TRANSACTION_NAMESPACE, contextId: 'expired-slot' },
        `AL_OUTBOUND:${TRANSACTION_NAMESPACE}`,
        { effectId: 'expired-slot' },
        Temporal.Instant.fromEpochMilliseconds(Date.now() - 1_000)
    );
    await backend.workQueue.enqueue(expired);

    expect(await backend.readWithin((session) => session.readWork(expired.key))).toBeUndefined();

    // The read answered its caller and wrote nothing: the row is still the slot a write would
    // fence, and the queue's own sweep is what removes it.
    expect(await backend.workQueue.cleanupAsync()).toEqual({ deleted: 1, saturated: false });
    expect(await backend.workQueue.getItem(expired.key)).toBeUndefined();
});

describe('control sends committed as one outbound admission', () => {
    it.each(['memory', 'indexeddb'] as const)('admits two acknowledgements from one sender over %s', async (storage) => {
        const runtime = await createControlSendRuntime(storage);

        const results = await runtime.enqueueAllIfAbsent([
            createAcknowledgement('first-ack'),
            createAcknowledgement('second-ack')
        ]);

        expect(results.map((result) => result.verdict)).toEqual([
            { kind: 'admitted', durable: true, queuedAttempts: 1 },
            { kind: 'admitted', durable: true, queuedAttempts: 1 }
        ]);
        expect(results.map((result) => result.message.id.msgId)).toEqual(['first-ack', 'second-ack']);
    });

    it('writes two acknowledgements from one sender in one readwrite transaction', async () => {
        const runtime = await createControlSendRuntime('indexeddb');

        const recorded = recordIndexedDbTransactions();
        await runtime.enqueueAllIfAbsent([createAcknowledgement('first-ack'), createAcknowledgement('second-ack')]);

        // Two decision reads, then one snapshot, one fence snapshot and one write for the pair: two
        // single sends spend a snapshot, a fence snapshot and a write each.
        expect(recorded.modes().filter((mode) => mode === 'readwrite')).toEqual(['readwrite']);
    });

    it.each(['memory', 'indexeddb'] as const)(
        'admits the rest of a group whose one member fails its planning over %s',
        async (storage) => {
            const runtime = await createControlSendRuntime(storage, AUTHORITY_BREAKING_PLANNER);

            const results = await runtime.enqueueAllIfAbsent([
                createAcknowledgement('good-ack'),
                createAcknowledgement('bad-ack')
            ]);

            // The answers two single sends give: the good one admitted, the bad one a failed value.
            expect(results.map((result) => result.verdict)).toEqual([
                { kind: 'admitted', durable: true, queuedAttempts: 1 },
                { kind: 'failed', detail: 'Outbound planned message changes original authority or deadline' }
            ]);
        }
    );

    it.each(['memory', 'indexeddb'] as const)(
        'commits every member alone before it rethrows the throw of an earlier one over %s',
        async (storage) => {
            const runtime = await createControlSendRuntime(storage, (msg) => {
                if (msg.id.msgId === 'throwing-ack') {
                    throw new Error('The planner is broken for this message');
                }
                return CONTROL_PLANNER(msg);
            });

            const good = createAcknowledgement('good-ack');

            await expect(
                runtime.enqueueAllIfAbsent([createAcknowledgement('throwing-ack'), good])
            ).rejects.toThrow('The planner is broken for this message');

            // The member after the throwing one was committed all the same: sending it again is a duplicate.
            expect((await runtime.enqueueIfAbsent(good)).verdict.kind).toBe('duplicate');
        }
    );

    it.each(['memory', 'indexeddb'] as const)(
        'sends a member that landed before the rethrow as promptly as a single send over %s',
        async (storage) => {
            const sentTexts: string[] = [];
            const runtime = await createControlSendRuntime(storage, (msg) => {
                if (msg.id.msgId === 'throwing-ack') {
                    throw new Error('The planner is broken for this message');
                }
                return CONTROL_PLANNER(msg);
            }, sentTexts);
            // A few idle engine passes, so the owner remembers storage answering "no work".
            await new Promise((resolve) => setTimeout(resolve, IDLE_OWNER_SETTLE_MS));

            await expect(
                runtime.enqueueAllIfAbsent([createAcknowledgement('throwing-ack'), createAcknowledgement('good-ack')])
            ).rejects.toThrow('The planner is broken for this message');

            // A single send wakes its owner at once; an unannounced row waits out the owner's
            // remembered readiness, which is longer than this poll's one second.
            await expect.poll(() => sentTexts).toEqual(['good-ack']);
        }
    );

    it.each(['memory', 'indexeddb'] as const)(
        'answers a newer and an older message of one supersedence key as serial sends do over %s',
        async (storage) => {
            const runtime = await createControlSendRuntime(storage, SUPERSEDING_PLANNER);
            const results = await runtime.enqueueAllIfAbsent([
                createOrderedOutboundMessage('superseding-newer', 2),
                createOrderedOutboundMessage('superseding-older', 1)
            ]);

            // Both members write the one latest row of the key, so the group answers `conflict`
            // and each message commits alone: the older one then reads the newer as latest.
            expect(results.map((result) => result.verdict.kind)).toEqual(['admitted', 'superseded']);
        }
    );
});

/** The outbound owner of a receiver, ready, so the measured window holds the admission and nothing of start-up. */
async function createControlSendRuntime(
    storage: 'memory' | 'indexeddb',
    planner: ALOutboundPlanner<OutboundTestPayload> = CONTROL_PLANNER,
    sentTexts: string[] = []
): Promise<ALOutboundMessageRuntime<OutboundTestPayload>> {
    const backend = storage === 'memory'
        ? new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now)
        : createTransactionBackend('control-sends');
    const runtime = createDefaultOutboundTestRuntime({
        stores: { admissionStore: createTransactionAdmissionStore(backend), workQueue: backend.workQueue },
        planOutgoingMessage: planner,
        sendPreparedMessage: async (prepared) => {
            sentTexts.push(String(prepared.text));
            return { status: 'sent' as const, submissionAttempted: true };
        }
    });
    await runtime.ready();
    return runtime;
}

function createOrderedOutboundMessage(resourceId: string, seq: number): ALMessage {
    return { ...createOutboundMessage(resourceId), ordering: { orderingKey: 'shared-topic', seq } };
}

function createAcknowledgement(msgId: string): ALMessage {
    return newALAckControlMessage(
        { v: 2, msgId, senderId: 'receiver', ts: Date.now() },
        {
            fromPeerId: 'receiver',
            toPeerId: 'sender',
            ackedMsgId: `${msgId}-target`,
            status: 'delivered',
            observedAtEpochMs: Date.now(),
            carrier: 'ws'
        }
    );
}
