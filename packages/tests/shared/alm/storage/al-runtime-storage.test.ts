import '../../../setup-browser-indexeddb.ts';

import { describe, expect, it, onTestFinished } from 'vitest';

import { createDefaultIndexedDbALInboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-database.ts';
import { ALRuntimeStorage } from '@shared/alm/storage/al-runtime-storage.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { EntityStatus, NEVER_EXPIRE_TS, toResourceEntryWithKey } from '@shared/queuebox/ResourceEntry.ts';

describe('AL runtime storage ownership', () => {
    it('keeps injected backends with their supplier while retiring factory-owned stores', async () => {
        const runtimeStorage = new ALRuntimeStorage();
        const supplied = new IndexedDbAdmissionBackend({
            dbName: `supplied-${crypto.randomUUID()}`,
            storeName: 'entries',
            nowMs: Date.now,
            newWriteToken: () => crypto.randomUUID(),
            observer: createPassThroughIndexedDbOperationObserver(),
            schemaId: AL_ADMISSION_SCHEMA_ID,
            onStorageReset: () => {}
        });
        const injected = createDefaultIndexedDbALInboundRuntimeStores({ runtimeStorage, inboundBackend: supplied });
        const owned = createDefaultIndexedDbALInboundRuntimeStores({ runtimeStorage, dbName: `owned-${crypto.randomUUID()}` });
        try {
            await Promise.all([injected.admissionStore.ready(), owned.admissionStore.ready()]);
            await runtimeStorage.close();
            await runtimeStorage.close();
            await expect(injected.workQueue.getAllKeys()).resolves.toEqual([]);
            await expect(owned.workQueue.getAllKeys()).rejects.toThrow('closed');
        }
        finally {
            await supplied.close();
        }
    });

    it('joins accepted queue work held before opening and rejects work after retirement', async () => {
        const runtimeStorage = new ALRuntimeStorage();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const stores = createDefaultIndexedDbALInboundRuntimeStores({
            runtimeStorage,
            dbName: `pending-work-${crypto.randomUUID()}`,
            observer: {
                observe: () => {
                    entered.resolve();
                    return release.promise;
                }
            }
        });
        const reading = stores.workQueue.getAllKeys();
        await entered.promise;
        let closed = false;
        const closing = runtimeStorage.close().then(() => {
            closed = true;
        });
        await Promise.resolve();
        expect(closed).toBe(false);
        release.resolve();
        await expect(reading).resolves.toEqual([]);
        await closing;
        await expect(stores.workQueue.getAllKeys()).rejects.toThrow('closed');
    });
    it('finishes an accepted single-page read before retirement and refuses a later page read', async () => {
        const runtimeStorage = new ALRuntimeStorage();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let pageObservations = 0;
        const stores = createDefaultIndexedDbALInboundRuntimeStores({
            runtimeStorage,
            dbName: `pending-page-${crypto.randomUUID()}`,
            observer: {
                observe: (operation) => {
                    if (operation.kind === 'work-page') {
                        pageObservations += 1;
                        entered.resolve();
                        return release.promise;
                    }
                }
            }
        });
        onTestFinished(async () => {
            release.resolve();
            await runtimeStorage.close();
        });
        const row = toResourceEntryWithKey(
            { topicId: 'test-work', contextId: 'lifecycle', resourceId: 'held' },
            'test-work',
            { value: 'kept' },
            NEVER_EXPIRE_TS
        );
        await stores.workQueue.enqueue(row);
        const request = { typeId: row.typeId, status: EntityStatus.NEW, maxToRead: 2, cursor: null } as const;
        const reading = stores.workQueue.readWorkPage(request);
        await entered.promise;
        let closed = false;
        const closing = runtimeStorage.close().then(() => {
            closed = true;
        });
        await Promise.resolve();
        expect(closed).toBe(false);
        release.resolve();
        expect(await reading).toMatchObject({ entries: [{ key: row.key, resource: row.resource }], nextCursor: null });
        await closing;
        await expect(stores.workQueue.readWorkPage(request)).rejects.toThrow('closed');
        expect(pageObservations).toBe(1);
    });
});
