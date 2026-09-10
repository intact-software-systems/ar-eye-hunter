import '../../../setup-browser-indexeddb.ts';

import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { createTestALOutboundControlAdmission } from '@shared-test/shared/create-test-al-outbound-work-port.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    newALAckControlMessage,
    newALRepairControlMessage,
    type ALRepairReason
} from '@shared/al-contracts/al-control.ts';
import {
    createInMemoryALAdmissionState,
    InMemoryAdmissionBackend,
    type ALAdmissionMemoryState
} from '@shared/alm/al-admission-backend.ts';
import type { ALAdmissionWorkBackend } from '@shared/alm/al-admission-work-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import {
    AL_ADMISSION_REVISION_KEY,
    AL_ADMISSION_SCHEMA_ID,
    openIndexedDbAdmissionDatabase
} from '@shared/alm/open-indexed-db-admission-database.ts';
import { toALOutboundMessageOwnerKey } from '@shared/alm/outbound/admission/al-outbound-admission-keys.ts';
import {
    createALOutboundAdmissionStore,
    type ALOutboundAdmissionStore,
    type ALOutboundCommitBundle,
    type ALOutboundNotYetInSyncRetrySchedule
} from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { captureALOutboundPolicy } from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';
import {
    captureALOutboundCreationExpiry,
    toALOutboundMessageReference
} from '@shared/alm/outbound/al-outbound-canonical-message.ts';
import { computeALOutboundWorkEntry } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { computeALOutboundDispatch } from '@shared/alm/outbound/compute-al-outbound-dispatch.ts';
import type { ALOutboundControlAdmission } from '@shared/alm/outbound/control/al-outbound-control-admission.ts';
import { toALOutboundEffectId } from '@shared/alm/outbound/to-al-outbound-effect-id.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { readIndexedDbRequest } from '@shared/persistence/indexed-db-request.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { PSqlAdmissionWorkBackend } from '@shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts';

import { createPSqlAdmissionTestStorage } from '../../../shared-server/al-runtime/postgres/create-p-sql-admission-test-storage.ts';
import {
    computeOutboundTestAdmission,
    createOutboundCanonicalEntry,
    createOutboundMessage
} from '../outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from '../outbound-test-payload.ts';

const ADMISSION_STORE_NAME = 'entries';
const FENCE_NAMESPACE = 'fence';

type FenceStorage = 'memory' | 'indexeddb' | 'pglite';

interface FenceFixture {
    readonly store: ALOutboundAdmissionStore<OutboundTestPayload>;
    readonly backend: ALAdmissionWorkBackend;
    /**
     * Everything a conflicting commit must leave untouched: every admission metadata row, plus the
     * optimistic revision the IndexedDB backend keeps as one of those rows and bumps on any commit
     * that read metadata. The in-memory backend has no revision counter, so its whole map is the
     * same witness.
     */
    readonly readAdmissionState: () => Promise<string>;
}

describe.each(['memory', 'indexeddb', 'pglite'] as const)('outbound admission fences over %s', (storage) => {
    it('aborts a changed sender version without a write or a revision bump', async () => {
        const fixture = await createFenceFixture(storage);
        const winner = await computeOutboundTestAdmission(fixture.store, createOutboundMessage('version-winner'));
        const stale = await computeOutboundTestAdmission(fixture.store, createOutboundMessage('version-loser'));

        expect(await fixture.store.commitBundle(winner)).toBe('committed');
        const before = await fixture.readAdmissionState();
        expect(await fixture.store.commitBundle(stale)).toBe('conflict');

        expect(await fixture.readAdmissionState()).toBe(before);
    });

    it('aborts a moved supersedence observation without a write or a revision bump', async () => {
        const fixture = await createFenceFixture(storage);
        const stale = await readSupersedingBundle(fixture.store, createSupersedingMessage('sender-a', 1));
        const winner = await readSupersedingBundle(fixture.store, createSupersedingMessage('sender-b', 2));

        expect(await fixture.store.commitBundle(winner)).toBe('committed');
        const before = await fixture.readAdmissionState();
        expect(await fixture.store.commitBundle(stale)).toBe('conflict');

        expect(await fixture.readAdmissionState()).toBe(before);
    });

    it('aborts a consumed pending admission without a write or a revision bump', async () => {
        const fixture = await createFenceFixture(storage);
        const message = createOutboundMessage('pending-fence');
        const canonicalEntry = createOutboundCanonicalEntry(fixture.store, message);
        expect(
            await fixture.store.retainPendingAdmission({
                canonicalEntry,
                creationExpiry: captureALOutboundCreationExpiry(message),
                payload: {
                    kind: 'admit-message',
                    message: toALOutboundMessageReference(fixture.store.canonicalScope, canonicalEntry, message),
                    policy: captureALOutboundPolicy({ msg: message, persist: false, preparedMessages: [{ peer: 'held' }] }),
                    preparedMessages: [{ peer: 'held' }]
                }
            })
        ).toBe('pending');
        const pending = await readOutboundWorkRow(fixture.backend, 'admit-message');
        const bundle = await readPendingAdmissionBundle({
            store: fixture.store,
            message,
            canonicalEntry,
            pendingAdmission: pending
        });
        // Another owner settles the retained admission between the read and the commit.
        await fixture.backend.workQueue.enqueue({ ...pending, status: EntityStatus.COMPLETED });

        const before = await fixture.readAdmissionState();
        expect(await fixture.store.commitBundle(bundle)).toBe('conflict');

        expect(await fixture.readAdmissionState()).toBe(before);
    });

    it('aborts a moved control owner without a write or a revision bump', async () => {
        const fixture = await createFenceFixture(storage);
        const control = createFenceControlAdmission(fixture);
        const message = await seedControlObligation(fixture.store);
        const write = fixture.backend.write.bind(fixture.backend);
        let before = '';
        vi.spyOn(fixture.backend, 'write').mockImplementationOnce(async (operation) => {
            // Another owner claims the message between the control read and its conditional write.
            await write(async (transaction) => {
                await transaction.set(toALOutboundMessageOwnerKey(FENCE_NAMESPACE, message.id.msgId), 'intruder');
            });
            before = await fixture.readAdmissionState();
            return await write(operation);
        });

        expect(await control.admit(toDeliveredAck(message))).toEqual({ kind: 'pending-control' });

        expect(await fixture.readAdmissionState()).toBe(before);
    });

    it('aborts a moved control effect without a write or a revision bump', async () => {
        const fixture = await createFenceFixture(storage);
        const control = createFenceControlAdmission(fixture);
        const message = await seedControlObligation(fixture.store);
        // Both repairs name the same repair-hint effect, so the second observes what the first wrote.
        expect(await control.admit(toRepairControl(message, 'retransmit'))).toEqual({ kind: 'committed' });
        const repairWork = await readOutboundWorkRow(fixture.backend, 'repair-hint');
        const write = fixture.backend.write.bind(fixture.backend);
        let before = '';
        vi.spyOn(fixture.backend, 'write').mockImplementationOnce(async (operation) => {
            // Another owner settles the repair the control forwards between its read and its write.
            await fixture.backend.workQueue.enqueue({ ...repairWork, status: EntityStatus.COMPLETED });
            before = await fixture.readAdmissionState();
            return await write(operation);
        });

        expect(await control.admit(toRepairControl(message, 'missing-seq'))).toEqual({ kind: 'pending-control' });

        expect(await fixture.readAdmissionState()).toBe(before);
    });

    it('aborts a retry schedule whose sender version moved without a write or a revision bump', async () => {
        const fixture = await createFenceFixture(storage);
        const control = createFenceControlAdmission(fixture);
        // The obligation's commit gives the sender its first version, so the schedule below carries
        // the expectation a repair admission computed before that commit landed.
        const message = await seedControlObligation(fixture.store);

        const before = await fixture.readAdmissionState();
        expect(await control.scheduleNotYetInSyncRetry(toRetrySchedule(message.id.senderId, message.id.msgId)))
            .toEqual({ status: 'conflict' });

        expect(await fixture.readAdmissionState()).toBe(before);
    });

    it('aborts a retry schedule whose effect moved without a write or a revision bump', async () => {
        const fixture = await createFenceFixture(storage);
        const control = createFenceControlAdmission(fixture);
        // A sender the store never committed for: its absent version is the one the schedule
        // expects, so the fence under test is the effect row, not the version.
        const schedule = toRetrySchedule('never-committed', 'retry-effect-fence');
        const write = fixture.backend.write.bind(fixture.backend);
        let before = '';
        vi.spyOn(fixture.backend, 'write').mockImplementationOnce(async (operation) => {
            // Another owner writes the retry's own effect row between the schedule's read and its write.
            await fixture.backend.workQueue.enqueue(toRetryEffectEntry(schedule.msgId));
            before = await fixture.readAdmissionState();
            return await write(operation);
        });

        expect(await control.scheduleNotYetInSyncRetry(schedule)).toEqual({ status: 'conflict' });

        expect(await fixture.readAdmissionState()).toBe(before);
    });
});

async function createFenceFixture(storage: FenceStorage): Promise<FenceFixture> {
    const namespace = FENCE_NAMESPACE;
    const fixture = storage === 'memory'
        ? createInMemoryFenceBackend()
        : storage === 'pglite'
        ? await createPGliteFenceBackend(namespace)
        : createIndexedDbFenceBackend(`fence-${crypto.randomUUID()}`);
    const store = createALOutboundAdmissionStore({
        nowMs: Date.now,
        canonicalScope: namespace,
        namespace,
        decodePrepared: decodeOutboundTestPayload,
        backend: fixture.backend,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    await store.ready();
    return { ...fixture, store };
}

/**
 * PostgreSQL keeps no store-wide revision row: every admission row carries its own, and a callback
 * that returns without mutating writes nothing at all. The whole namespace with those per-row
 * revisions is therefore the same witness the other two backends' whole-store fingerprint is.
 */
async function createPGliteFenceBackend(namespace: string): Promise<Omit<FenceFixture, 'store'>> {
    const { sql, repository } = await createPSqlAdmissionTestStorage();
    return {
        backend: new PSqlAdmissionWorkBackend(sql, namespace),
        readAdmissionState: async () => toAdmissionStateFingerprint('per-row', await repository.findAllEntries(namespace))
    };
}

function createInMemoryFenceBackend(): Omit<FenceFixture, 'store'> {
    const state: ALAdmissionMemoryState = createInMemoryALAdmissionState();
    return {
        backend: new InMemoryAdmissionBackend(state, Date.now),
        readAdmissionState: async () => toAdmissionStateFingerprint('none', [...state.data.values()])
    };
}

function createIndexedDbFenceBackend(dbName: string): Omit<FenceFixture, 'store'> {
    return {
        backend: new IndexedDbAdmissionBackend({
            schemaId: AL_ADMISSION_SCHEMA_ID,
            onStorageReset: () => {},
            dbName,
            storeName: ADMISSION_STORE_NAME,
            nowMs: Date.now,
            newWriteToken: crypto.randomUUID.bind(crypto),
            observer: createPassThroughIndexedDbOperationObserver()
        }),
        readAdmissionState: async () => await readIndexedDbAdmissionState(dbName)
    };
}

async function readIndexedDbAdmissionState(dbName: string): Promise<string> {
    const db = await openIndexedDbAdmissionDatabase({
        dbName,
        storeName: ADMISSION_STORE_NAME,
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {}
    });
    try {
        const rows: readonly AdmissionStateRow[] = await readIndexedDbRequest(
            db.transaction(ADMISSION_STORE_NAME, 'readonly').objectStore(ADMISSION_STORE_NAME).getAll()
        );
        const revision = rows.find((row) => row.key === AL_ADMISSION_REVISION_KEY);
        return toAdmissionStateFingerprint(JSON.stringify(revision), rows);
    }
    finally {
        db.close();
    }
}

interface AdmissionStateRow {
    readonly key: string;
}

function toAdmissionStateFingerprint(revision: string, rows: readonly AdmissionStateRow[]): string {
    return JSON.stringify({
        revision,
        rows: rows.toSorted((left, right) => left.key.localeCompare(right.key))
    });
}

/** A committed message the receiver still owes an acknowledgement for: what a control admission needs. */
async function seedControlObligation(store: ALOutboundAdmissionStore<OutboundTestPayload>): Promise<ALMessage> {
    const message = createOutboundMessage('control-fence');
    const admission = await computeOutboundTestAdmission(store, message);
    const committed = await store.commitBundle({
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
    });
    expect(committed).toBe('committed');
    return message;
}

function toDeliveredAck(message: ALMessage): ALMessage {
    return newALAckControlMessage({ v: 2, msgId: `${message.id.msgId}-ack`, senderId: 'peer-1', ts: Date.now() }, {
        fromPeerId: 'peer-1',
        toPeerId: message.id.senderId,
        ackedMsgId: message.id.msgId,
        status: 'delivered',
        observedAtEpochMs: Date.now()
    });
}

function createFenceControlAdmission(fixture: FenceFixture): ALOutboundControlAdmission<OutboundTestPayload> {
    return createTestALOutboundControlAdmission({
        admissionStore: fixture.store,
        workQueue: fixture.backend.workQueue,
        nowMs: Date.now
    });
}

function toRepairControl(message: ALMessage, reason: ALRepairReason): ALMessage {
    const observedAtEpochMs = Date.now();
    return newALRepairControlMessage(
        { v: 2, msgId: `${message.id.msgId}-${reason}`, senderId: 'peer-1', ts: observedAtEpochMs },
        {
            fromPeerId: 'peer-1',
            toPeerId: message.id.senderId,
            msgId: message.id.msgId,
            reason,
            observedAtEpochMs
        }
    );
}

/** The schedule a repair admission computes for a sender it observed without a version. */
function toRetrySchedule(senderId: string, msgId: string): ALOutboundNotYetInSyncRetrySchedule {
    const nowMs = Date.now();
    return {
        senderId,
        expectedVersion: undefined,
        msgId,
        maxAttempts: 3,
        expireAtTimestamp: nowMs + 60_000,
        retryAtMs: nowMs
    };
}

/** The queue row the first attempt of that schedule would write, as a foreign owner already wrote it. */
function toRetryEffectEntry(msgId: string): ResourceEntry {
    const nowMs = Date.now();
    return computeALOutboundWorkEntry({
        namespace: FENCE_NAMESPACE,
        effectId: toALOutboundEffectId(['nack-retry', msgId, 'not-yet-in-sync', 1]),
        payload: { kind: 'nack-retry', msgId, reason: 'not-yet-in-sync' },
        observedAtMs: nowMs,
        retryAtMs: nowMs,
        expireAtTimestamp: nowMs + 60_000
    });
}

function createSupersedingMessage(senderId: string, sequence: number): ALMessage {
    const message = createOutboundMessage(`superseding-${sequence}`);
    return { ...message, id: { ...message.id, senderId }, ordering: { orderingKey: 'shared-topic', seq: sequence } };
}

async function readSupersedingBundle(
    store: ALOutboundAdmissionStore<OutboundTestPayload>,
    message: ALMessage
): Promise<ALOutboundCommitBundle<OutboundTestPayload>> {
    return await computeOutboundTestAdmission(store, message, (msg) => ({
        msg,
        persist: false,
        preparedMessages: [{ text: msg.id.msgId }],
        supersedenceTracking: { enabled: true, algo: 'latest-wins', key: 'shared-topic' }
    }));
}

async function readOutboundWorkRow(backend: ALAdmissionWorkBackend, kind: string): Promise<ResourceEntry> {
    const rows = await Promise.all(
        (await backend.workQueue.getAllKeys()).map((key) => backend.workQueue.getItem(key))
    );
    const found = rows.find((row) => row?.resource.includes(`"kind":"${kind}"`));
    if (!found) {
        throw new Error(`Expected a retained ${kind} work row`);
    }
    return found;
}

interface PendingAdmissionBundleInput {
    readonly store: ALOutboundAdmissionStore<OutboundTestPayload>;
    readonly message: ALMessage;
    readonly canonicalEntry: ResourceEntry;
    readonly pendingAdmission: ResourceEntry;
}

async function readPendingAdmissionBundle(
    input: PendingAdmissionBundleInput
): Promise<ALOutboundCommitBundle<OutboundTestPayload>> {
    const read = await input.store.readOutgoingMessage({
        msg: input.message,
        planner: (msg) => ({ msg, persist: false, preparedMessages: [{ peer: 'held' }] }),
        observedCanonicalEntry: undefined,
        intent: 'enqueue'
    });
    const computed = computeALOutboundDispatch({
        read,
        outboxEntry: input.canonicalEntry,
        dispatchAtMs: Date.now(),
        intent: 'enqueue',
        phase: 'immediate',
        options: { pendingAdmission: input.pendingAdmission }
    });
    if (!computed.bundle) {
        throw new Error(`Expected a pending admission bundle, received ${computed.status}`);
    }
    return computed.bundle;
}
