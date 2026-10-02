import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, vi } from 'vitest';

import { newALEventRoute, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { createDefaultIndexedDbALInboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import {
    AL_ADMISSION_SCHEMA_ID,
    openIndexedDbAdmissionDatabase
} from '@shared/alm/open-indexed-db-admission-database.ts';
import type { ALStorageEvent, ALStorageRecoveryOutcome } from '@shared/alm/storage/al-storage-event.ts';
import { ALStorageHealth } from '@shared/alm/storage/al-storage-health.ts';
import { IndexedDbStringPersistenceProvider } from '@shared/persistence/indexed-db-string-persistence-provider.ts';
import { NEW_AND_RETRY_STATUSES, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import '../../setup-browser-indexeddb.ts';

import { createInboundTestRuntime } from './inbound-runtime-test-fixture.ts';

const STORE_ID = 'recovery-store';
const WORK_TYPE = 'RECOVERY_WORK';
const START_MS = 1_800_000_000_000;

describe('storage recovery outcome of a durable store', () => {
    it('reads storage-created when its open created the database', async () => {
        const store = await openRecoveryStore(newDbName());

        store.report(0);

        expect(store.events).toEqual([toRecoveryEvent({ kind: 'storage-created' })]);
    });

    // A reset recreates the database too: the reset is what the store reports.
    it('reads storage-reset over the creation when its open reset a mismatched schema', async () => {
        const dbName = newDbName();
        (await openIndexedDbAdmissionDatabase({ ...toDatabaseInput(dbName), schemaId: 'an-older-schema' })).close();

        const store = await openRecoveryStore(dbName);
        store.report(0);

        expect(store.events).toEqual([toRecoveryEvent({ kind: 'storage-reset', reason: 'schema-id-mismatch' })]);
    });

    it('reads storage-reset from another context when a versionchange preceded the creation', async () => {
        const dbName = newDbName();
        await openIndexedDbAdmissionDatabase(toDatabaseInput(dbName));
        await deleteDatabase(dbName);

        const store = await openRecoveryStore(dbName);
        store.report(0);

        expect(store.events).toEqual([toRecoveryEvent({ kind: 'storage-reset', reason: 'other-context' })]);
    });

    // An eviction closes the connection without a versionchange, then the next open creates the database.
    it('records failing health with cause evicted when a database this document opened is created again', async () => {
        const dbName = newDbName();
        (await openIndexedDbAdmissionDatabase(toDatabaseInput(dbName))).close();
        await deleteDatabase(dbName);

        const store = await openRecoveryStore(dbName);
        store.report(0);

        await vi.waitFor(() =>
            expect(store.events).toEqual([{
                kind: 'health',
                storeId: STORE_ID,
                status: 'failing',
                lastFailure: { cause: 'evicted', detail: expect.any(String) },
                lastRecoveryPointAtMs: undefined
            }])
        );
    });

    it('reads restored with the first batch\'s claims and the expired rows its reservation deleted', async () => {
        const dbName = newDbName();
        const clock = { nowMs: START_MS };
        const previous = await openRecoveryStore(dbName, clock);
        await previous.stores.workQueue.enqueue(workEntry(undefined));
        await previous.stores.workQueue.enqueue(workEntry(START_MS + 1_000));
        clock.nowMs = START_MS + 2_000;

        const store = await openRecoveryStore(dbName, clock);
        const claimed = await reserveAll(store.stores.workQueue);
        store.report(claimed.size);

        expect(claimed.size).toBe(1);
        expect(store.events).toEqual([toRecoveryEvent({ kind: 'restored', claimed: 1, expired: 1 })]);
    });

    it('reads expired-at-recovery when the first batch claimed nothing and its reservation deleted expired rows', async () => {
        const dbName = newDbName();
        const clock = { nowMs: START_MS };
        const previous = await openRecoveryStore(dbName, clock);
        await previous.stores.workQueue.enqueue(workEntry(START_MS + 1_000));
        clock.nowMs = START_MS + 2_000;

        const store = await openRecoveryStore(dbName, clock);
        store.report((await reserveAll(store.stores.workQueue)).size);

        expect(store.events).toEqual([toRecoveryEvent({ kind: 'expired-at-recovery', expired: 1 })]);
    });

    it('reads restored with nothing claimed when an existing database held no work', async () => {
        const dbName = newDbName();
        await openRecoveryStore(dbName);

        const store = await openRecoveryStore(dbName);
        store.report(0);

        expect(store.events).toEqual([toRecoveryEvent({ kind: 'restored', claimed: 0, expired: 0 })]);
    });

    it('reports once per store, from the first batch only', async () => {
        const store = await openRecoveryStore(newDbName());

        store.report(0);
        store.report(3);

        expect(store.events).toHaveLength(1);
    });

    it('reports one outcome from a durable lane\'s first work batch', async () => {
        const events: ALStorageEvent[] = [];
        const stores = createDefaultIndexedDbALInboundRuntimeStores({
            dbName: newDbName(),
            namespace: 'recovery-lane',
            storageHealth: new ALStorageHealth({ storeId: STORE_ID, storage: (event) => events.push(event) })
        });
        const { runtime } = createInboundTestRuntime({ stores, carrier: 'ws', effectWorkerId: 'al-inbound:recovery' });

        await runtime.ready();
        await runtime.ready();

        expect(events).toEqual([toRecoveryEvent({ kind: 'storage-created' })]);
    });
});

interface RecoveryStore {
    readonly stores: ReturnType<typeof createDefaultIndexedDbALInboundRuntimeStores>;
    readonly events: readonly ALStorageEvent[];
    report(claimedCount: number): void;
}

async function openRecoveryStore(dbName: string, clock = { nowMs: START_MS }): Promise<RecoveryStore> {
    const events: ALStorageEvent[] = [];
    const stores = createDefaultIndexedDbALInboundRuntimeStores({
        dbName,
        namespace: 'recovery',
        nowMs: () => clock.nowMs,
        storageHealth: new ALStorageHealth({ storeId: STORE_ID, storage: (event) => events.push(event) })
    });
    await stores.admissionStore.ready();
    return {
        stores,
        events,
        report: (claimedCount) => stores.storageRecovery?.reportFirstBatch(claimedCount)
    };
}

function toRecoveryEvent(outcome: ALStorageRecoveryOutcome): ALStorageEvent {
    return { kind: 'recovery', storeId: STORE_ID, outcome };
}

async function reserveAll(queue: RecoveryStore['stores']['workQueue']) {
    return await queue.reserveEntries({
        typeIds: new Set([WORK_TYPE]),
        statusIds: new Set(NEW_AND_RETRY_STATUSES),
        reservationInput: { maxToReserve: 16, maxAttempts: 5 },
        observedEntries: undefined
    });
}

/** Undefined `expiresAtMs` keeps the row until it is claimed. */
function workEntry(expiresAtMs: number | undefined): ResourceEntry {
    const entry = QueueBoxUtilities.toResourceEntryFromMsg(
        newALUnicastMessage('sender', newALEventRoute('test', crypto.randomUUID()), 'receiver', 'test', { value: 1 }),
        WORK_TYPE
    );
    return expiresAtMs === undefined
        ? entry
        : { ...entry, audit: { ...entry.audit, expiryTs: Temporal.Instant.fromEpochMilliseconds(expiresAtMs) } };
}

function toDatabaseInput(dbName: string) {
    return {
        dbName,
        storeName: IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME,
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {}
    };
}

function newDbName(): string {
    return `storage-recovery-${crypto.randomUUID()}`;
}

async function deleteDatabase(dbName: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(dbName);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}
