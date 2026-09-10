import 'fake-indexeddb/auto';
import { decodeALAdmissionString } from '@shared/alm/al-admission-value-validation.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-database.ts';
import { createCountingIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { IndexedDbStringPersistenceProvider } from '@shared/persistence/indexed-db-string-persistence-provider.ts';
import { describe, expect, it } from 'vitest';

describe('AL-owned IndexedDB operation counts', () => {
    it('counts admission reads, writes, and work operations through the backend', async () => {
        const observer = createCountingIndexedDbOperationObserver();
        const backend = new IndexedDbAdmissionBackend({
            schemaId: AL_ADMISSION_SCHEMA_ID,
            onStorageReset: () => {},
            dbName: `al-counts-${crypto.randomUUID()}`,
            storeName: IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME,
            nowMs: () => 1_000,
            newWriteToken: () => crypto.randomUUID(),
            observer
        });
        await backend.ready();

        await backend.read('missing', decodeALAdmissionString);
        await backend.write(async (tx) => {
            await tx.set('present', 'value');
        });
        await backend.workQueue.readWorkPage({
            typeId: 'AL_OUTBOUND:test',
            status: 'NEW',
            maxToRead: 4,
            cursor: null
        });

        const counts = observer.getCounts();
        expect(counts.byOwner['al-admission']).toBe(2);
        expect(counts.byKind.read).toBe(1);
        expect(counts.byKind.write).toBe(1);
        expect(counts.byKind['work-page']).toBe(1);
        expect(counts.byOwner['al-work']).toBe(1);
    });
});
