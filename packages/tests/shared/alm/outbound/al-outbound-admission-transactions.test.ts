import '../../../setup-browser-indexeddb.ts';

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

/** Every transaction the run opened, in order, so a pin can separate the read chain from the write. */
function recordIndexedDbTransactions(): { modes(): readonly IDBTransactionMode[]; } {
    const modes: IDBTransactionMode[] = [];
    const openTransaction = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
        this: IDBDatabase,
        storeNames: string | Iterable<string>,
        mode?: IDBTransactionMode,
        options?: IDBTransactionOptions
    ) {
        modes.push(mode ?? 'readonly');
        return openTransaction.call(this, storeNames, mode, options);
    });
    return { modes: () => modes };
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
