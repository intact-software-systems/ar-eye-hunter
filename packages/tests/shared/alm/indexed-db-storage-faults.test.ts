import { describe, expect, it } from 'vitest';

import { newALEventRoute, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-database.ts';
import type {
    IndexedDbOperation,
    IndexedDbOperationObserver
} from '@shared/persistence/indexed-db-operation-observer.ts';
import { createScriptedStorageFaultPort } from '@shared/persistence/storage-fault-port.ts';
import { EntityStatus, NEW_AND_RETRY_STATUSES } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import '../../setup-browser-indexeddb.ts';

const WORK_TYPE = 'STORAGE_FAULT_WORK';

describe('storage faults through the IndexedDB owners', () => {
    it('fails an admission write with QuotaExceededError and writes nothing', async () => {
        const faults = createScriptedStorageFaultPort();
        const backend = createBackend(faults);
        faults.inject({
            faultId: 'quota',
            carrier: 'storage',
            match: { owner: 'al-admission', kind: 'write' },
            action: 'quota',
            remaining: 1
        });

        await expect(backend.write((tx) => tx.set('kept', 'value'))).rejects.toMatchObject({
            name: 'QuotaExceededError'
        });

        expect(await backend.read('kept', String)).toBeUndefined();
        await backend.write((tx) => tx.set('kept', 'value'));
        expect(await backend.read('kept', String)).toBe('value');
    });

    it('fails a read-session read before it reaches the snapshot', async () => {
        const faults = createScriptedStorageFaultPort();
        const backend = createBackend(faults);
        await backend.write((tx) => tx.set('session', 'value'));
        faults.inject({
            faultId: 'session-read',
            carrier: 'storage',
            match: { owner: 'al-admission', kind: 'read' },
            action: 'fail',
            remaining: 1
        });

        await expect(backend.readWithin((session) => session.read('session', String))).rejects
            .toMatchObject({
                name: 'UnknownError'
            });
        expect(await backend.readWithin((session) => session.read('session', String))).toBe(
            'value'
        );
    });

    // The reservation's decision sits between its finished read and its write: the row stays claimable.
    it('fails a reservation write and leaves the row unreserved', async () => {
        const faults = createScriptedStorageFaultPort();
        const backend = createBackend(faults);
        const entry = workEntry();
        await backend.workQueue.enqueue(entry);
        faults.inject({
            faultId: 'reserve',
            carrier: 'storage',
            match: { owner: 'al-work', kind: 'work-reserve' },
            action: 'quota',
            remaining: 1
        });

        await expect(reserveOne(backend)).rejects.toMatchObject({ name: 'QuotaExceededError' });

        const stored = await backend.workQueue.getItem(entry.key);
        expect(stored?.status).toBe(EntityStatus.NEW);
        expect(stored?.dequeueAudit.attempts).toBe(0);
        expect([...(await reserveOne(backend)).values()].map((reserved) => reserved.resource))
            .toEqual([
                entry.resource
            ]);
    });

    it.each(
        [
            { owner: 'al-admission', kind: 'read' },
            { owner: 'al-work', kind: 'work-page' }
        ] as const
    )('holds a $owner $kind until its decision settles', async (held) => {
        const gate = createHeldObserver(held);
        const backend = createBackend(gate.observer);
        await backend.write((tx) => tx.set('held', 'value'));
        let settled = false;

        const operation = (held.kind === 'read'
            ? backend.read('held', String)
            : backend.workQueue.readWorkPage({
                typeId: WORK_TYPE,
                status: EntityStatus.NEW,
                maxToRead: 1,
                cursor: null
            }))
            .then(() => {
                settled = true;
            });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(settled).toBe(false);

        gate.release();
        await operation;
        expect(settled).toBe(true);
    });
});

function createBackend(observer: IndexedDbOperationObserver): IndexedDbAdmissionBackend {
    return new IndexedDbAdmissionBackend({
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {},
        dbName: `storage-faults-${crypto.randomUUID()}`,
        storeName: 'entries',
        nowMs: Date.now,
        newWriteToken: crypto.randomUUID.bind(crypto),
        observer
    });
}

/** Holds the first operation that matches `held` until `release`; every other operation runs at once. */
function createHeldObserver(
    held: IndexedDbOperation
): { observer: IndexedDbOperationObserver; release(): void; } {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let armed = true;
    return {
        observer: {
            observe(operation) {
                if (!armed || operation.owner !== held.owner || operation.kind !== held.kind) {
                    return undefined;
                }
                armed = false;
                return gate;
            }
        },
        release: () => release()
    };
}

async function reserveOne(backend: IndexedDbAdmissionBackend) {
    return await backend.workQueue.reserveEntries({
        typeIds: new Set([WORK_TYPE]),
        statusIds: new Set(NEW_AND_RETRY_STATUSES),
        reservationInput: { maxToReserve: 1, maxAttempts: 5 },
        observedEntries: undefined
    });
}

function workEntry() {
    return QueueBoxUtilities.toResourceEntryFromMsg(
        newALUnicastMessage(
            'sender',
            newALEventRoute('test', crypto.randomUUID()),
            'receiver',
            'test',
            { value: 1 }
        ),
        WORK_TYPE
    );
}
