import '../../../setup-browser-indexeddb.ts';

import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    expect,
    it,
    vi
} from 'vitest';

import { createTestALOutboundControlAdmission } from '@shared-test/shared/create-test-al-outbound-work-port.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-database.ts';
import {
    createALOutboundAdmissionStore,
    type ALOutboundAdmissionStore,
    type ALOutboundPlanner
} from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { toResourceEntryWithKey } from '@shared/queuebox/ResourceEntry.ts';

import {
    computeOutboundTestAdmission,
    createOutboundMessage
} from '../outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from '../outbound-test-payload.ts';

afterEach(() => {
    vi.restoreAllMocks();
});

const TRANSACTION_NAMESPACE = 'admission-transactions';

/** Tracks the supersedence pair, so a re-admission walks both of its dependent read hops. */
const SUPERSEDING_PLANNER: ALOutboundPlanner<OutboundTestPayload> = (msg) => ({
    msg,
    persist: true,
    preparedMessages: [{ text: msg.id.msgId }],
    supersedenceTracking: { enabled: true, algo: 'latest-wins', key: 'shared-topic' }
});

const SEND_PLANNER: ALOutboundPlanner<OutboundTestPayload> = (msg) => ({
    msg,
    persist: true,
    preparedMessages: [{ text: msg.id.msgId }]
});

interface RecordedIndexedDbTransactions {
    /** Every transaction the run opened, in order, so a pin can separate the read chain from the write. */
    modes(): readonly IDBTransactionMode[];
    /** How many earlier transactions still held their store locks as each one was created. */
    liveWhenOpened(): readonly number[];
    /** How many transactions still hold their store locks now. */
    liveCount(): number;
}

function recordIndexedDbTransactions(): RecordedIndexedDbTransactions {
    const modes: IDBTransactionMode[] = [];
    const liveWhenOpened: number[] = [];
    const live = new Set<IDBTransaction>();
    const openTransaction = IDBDatabase.prototype.transaction;
    const abortTransaction = IDBTransaction.prototype.abort;
    // abort() finishes the transaction there and then; its event arrives a task later, which is
    // already too late to say whether the write that followed queued behind it.
    vi.spyOn(IDBTransaction.prototype, 'abort').mockImplementation(function (this: IDBTransaction) {
        live.delete(this);
        abortTransaction.call(this);
    });
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
        this: IDBDatabase,
        storeNames: string | Iterable<string>,
        mode?: IDBTransactionMode,
        options?: IDBTransactionOptions
    ) {
        modes.push(mode ?? 'readonly');
        liveWhenOpened.push(live.size);
        const transaction = openTransaction.call(this, storeNames, mode, options);
        live.add(transaction);
        for (const ended of ['complete', 'abort', 'error']) {
            transaction.addEventListener(ended, () => live.delete(transaction));
        }
        return transaction;
    });
    return {
        modes: () => modes,
        liveWhenOpened: () => liveWhenOpened,
        liveCount: () => live.size
    };
}

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
    const backend = new IndexedDbAdmissionBackend({
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {},
        dbName: `${TRANSACTION_NAMESPACE}-${name}-${crypto.randomUUID()}`,
        storeName: 'entries',
        nowMs: Date.now,
        newWriteToken: crypto.randomUUID.bind(crypto),
        observer: createPassThroughIndexedDbOperationObserver()
    });
    const store = createALOutboundAdmissionStore({
        nowMs: Date.now,
        canonicalScope: TRANSACTION_NAMESPACE,
        decodePrepared: decodeOutboundTestPayload,
        namespace: TRANSACTION_NAMESPACE,
        backend,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    // Opening the database is the fixture's cost, never the read chain's.
    await store.ready();
    return { store, backend };
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
                }
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
        nowMs: Date.now
    });
    const ack = newALAckControlMessage(
        { v: 2, msgId: `${message.id.msgId}-ack`, senderId: 'peer-1', ts: Date.now() },
        {
            fromPeerId: 'peer-1',
            toPeerId: message.id.senderId,
            ackedMsgId: message.id.msgId,
            status: 'delivered',
            observedAtEpochMs: Date.now()
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
