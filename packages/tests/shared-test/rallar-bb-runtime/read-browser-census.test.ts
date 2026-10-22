import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import { readIndexedDbRequest, waitForIndexedDbTransaction } from '@shared/persistence/indexed-db-request.ts';

import { readBrowserCensus } from '../../../shared-test/rallar-bb-test/control-client/read-browser-census.ts';

const PAGE_HEAP = { usedJSHeapSize: 21_000_000, totalJSHeapSize: 34_000_000, jsHeapSizeLimit: 4_294_705_152 };

/** Creates `name` at version 1 with each store holding its given rows, keyed by position. */
async function writeDatabase(factory: IDBFactory, name: string, rowsByStore: Readonly<Record<string, number>>): Promise<void> {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => {
        for (const storeName of Object.keys(rowsByStore)) {
            request.result.createObjectStore(storeName);
        }
    };
    const db = await readIndexedDbRequest(request);
    const storeNames = Object.keys(rowsByStore);
    if (storeNames.length > 0) {
        const transaction = db.transaction(storeNames, 'readwrite');
        for (const [storeName, rows] of Object.entries(rowsByStore)) {
            for (let row = 0; row < rows; row += 1) {
                transaction.objectStore(storeName).put({ row }, row);
            }
        }
        await waitForIndexedDbTransaction(transaction);
    }
    db.close();
}

describe('readBrowserCensus', () => {
    it('counts the rows of every store of every database the page lists, beside the page heap', async () => {
        const factory = new IDBFactory();
        await writeDatabase(factory, 'rallar-al-runtime:app-1:workspace-1', { 'al-runtime': 4, 'al-work': 2 });
        await writeDatabase(factory, 'rallar-crdt', {});

        const census = await readBrowserCensus({ indexedDb: factory, performance: { memory: PAGE_HEAP } });

        expect(census).toEqual({
            indexedDb: {
                databases: [
                    {
                        name: 'rallar-al-runtime:app-1:workspace-1',
                        version: 1,
                        stores: [{ name: 'al-runtime', rows: 4 }, { name: 'al-work', rows: 2 }]
                    },
                    { name: 'rallar-crdt', version: 1, stores: [] }
                ],
                uncounted: []
            },
            pageHeap: PAGE_HEAP
        });
    });

    it('names a listed database it could not count, and never creates one deleted since the listing', async () => {
        const factory = new IDBFactory();
        await writeDatabase(factory, 'kept', { rows: 1 });
        const staleListing = Object.assign(Object.create(factory) as IDBFactory, {
            databases: async () => [{ name: 'deleted-since', version: 3 }, ...await factory.databases()]
        });

        const census = await readBrowserCensus({ indexedDb: staleListing, performance: undefined });

        expect(census.indexedDb).toEqual({
            databases: [{ name: 'kept', version: 1, stores: [{ name: 'rows', rows: 1 }] }],
            uncounted: ['deleted-since']
        });
        expect((await factory.databases()).map(({ name }) => name)).toEqual(['kept']);
    });

    it('leaves out what the runtime does not offer: IndexedDB, its listing, or a page heap', async () => {
        const unlisting = Object.assign(Object.create(new IDBFactory()) as IDBFactory, { databases: undefined });
        const failingListing = Object.assign(Object.create(new IDBFactory()) as IDBFactory, {
            databases: async () => {
                throw new Error('listing denied');
            }
        });

        expect(await readBrowserCensus({ indexedDb: undefined, performance: {} })).toEqual({});
        expect(await readBrowserCensus({ indexedDb: unlisting, performance: { memory: { usedJSHeapSize: 'large' } } }))
            .toEqual({});
        expect(await readBrowserCensus({ indexedDb: failingListing, performance: undefined })).toEqual({});
    });
});
