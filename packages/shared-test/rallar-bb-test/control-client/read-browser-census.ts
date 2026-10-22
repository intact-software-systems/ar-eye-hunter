import { readIndexedDbRequest } from '@shared/persistence/indexed-db-request.ts';

import { decodeNonNegativeInteger, decodeRecord } from '../runtime/decode-runtime-result-values.ts';
import type {
    RallarBlackBoxBrowserCensus,
    RallarBlackBoxIndexedDbCensus,
    RallarBlackBoxIndexedDbDatabaseCensus,
    RallarBlackBoxIndexedDbStoreCensus,
    RallarBlackBoxPageHeap
} from '../runtime/runtime-stats-contracts.ts';

export interface ReadBrowserCensusInput {
    /** Undefined where the runtime has no IndexedDB. */
    readonly indexedDb: IDBFactory | undefined;
    /** Undefined where the runtime has no `performance`. */
    readonly performance: object | undefined;
}

/** Never rejects: a reading the runtime does not offer, or that fails, is left out. */
export async function readBrowserCensus(input: ReadBrowserCensusInput): Promise<RallarBlackBoxBrowserCensus> {
    const indexedDb = input.indexedDb === undefined ? undefined : await readIndexedDbCensus(input.indexedDb);
    const pageHeap = readPageHeap(input.performance);
    return {
        ...(indexedDb === undefined ? {} : { indexedDb }),
        ...(pageHeap === undefined ? {} : { pageHeap })
    };
}

export function createDefaultBrowserCensusReader(): () => Promise<RallarBlackBoxBrowserCensus> {
    return async () =>
        await readBrowserCensus({
            indexedDb: typeof indexedDB === 'undefined' ? undefined : indexedDB,
            performance: typeof performance === 'undefined' ? undefined : performance
        });
}

async function readIndexedDbCensus(factory: IDBFactory): Promise<RallarBlackBoxIndexedDbCensus | undefined> {
    if (typeof factory.databases !== 'function') {
        return undefined;
    }
    const listed = await factory.databases().catch(() => undefined);
    if (listed === undefined) {
        return undefined;
    }
    const databases: RallarBlackBoxIndexedDbDatabaseCensus[] = [];
    const uncounted: string[] = [];
    for (const { name } of listed) {
        if (name === undefined) {
            continue;
        }
        const counted = await readDatabaseCensus(factory, name).catch(() => undefined);
        if (counted === undefined) {
            uncounted.push(name);
            continue;
        }
        databases.push(counted);
    }
    return { databases, uncounted };
}

async function readDatabaseCensus(
    factory: IDBFactory,
    name: string
): Promise<RallarBlackBoxIndexedDbDatabaseCensus | undefined> {
    const db = await openListedDatabase(factory, name);
    if (db === undefined) {
        return undefined;
    }
    try {
        return { name, version: db.version, stores: await readStoreRows(db) };
    }
    finally {
        db.close();
    }
}

/**
 * Opens the database at its current version. One deleted since the listing would be created empty by the open, so its
 * creation is aborted and it reads as uncounted; the census closes as soon as the page's own code upgrades it.
 */
function openListedDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase | undefined> {
    return new Promise((resolve) => {
        const request = factory.open(name);
        request.onupgradeneeded = () => request.transaction?.abort();
        request.onerror = () => resolve(undefined);
        request.onsuccess = () => {
            request.result.onversionchange = () => request.result.close();
            resolve(request.result);
        };
    });
}

async function readStoreRows(db: IDBDatabase): Promise<readonly RallarBlackBoxIndexedDbStoreCensus[]> {
    const storeNames = Array.from(db.objectStoreNames);
    if (storeNames.length === 0) {
        return [];
    }
    const transaction = db.transaction(storeNames, 'readonly');
    return await Promise.all(storeNames.map(async (storeName) => ({
        name: storeName,
        rows: await readIndexedDbRequest(transaction.objectStore(storeName).count())
    })));
}

function readPageHeap(performance: object | undefined): RallarBlackBoxPageHeap | undefined {
    const memory = performance !== undefined && 'memory' in performance ? decodeRecord(performance.memory) : {};
    const usedJSHeapSize = decodeNonNegativeInteger(memory.usedJSHeapSize);
    const totalJSHeapSize = decodeNonNegativeInteger(memory.totalJSHeapSize);
    const jsHeapSizeLimit = decodeNonNegativeInteger(memory.jsHeapSizeLimit);
    return usedJSHeapSize === undefined || totalJSHeapSize === undefined || jsHeapSizeLimit === undefined
        ? undefined
        : { usedJSHeapSize, totalJSHeapSize, jsHeapSizeLimit };
}
