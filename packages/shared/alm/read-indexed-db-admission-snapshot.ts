import {
    readIndexedDbRequest,
    readIndexedDbTransaction
} from '../persistence/indexed-db-request.ts';
import { ALAdmissionCorruptionError } from './al-admission-decoder.ts';
import {
    decodeIndexedDbAdmissionStoredRow,
    type IndexedDbAdmissionStoredRow
} from './indexed-db-admission-row.ts';
import {
    AL_ADMISSION_EXPIRY_INDEX_NAME,
    AL_ADMISSION_REVISION_KEY,
    decodeIndexedDbAdmissionRevision
} from './open-indexed-db-admission-database.ts';

interface IndexedDbAdmissionSnapshot {
    readonly revision: number;
    readonly stored: readonly IndexedDbAdmissionStoredRow[];
}

type IndexedDbAdmissionSelection =
    | Readonly<{ kind: 'key'; key: string; }>
    | Readonly<{ kind: 'prefixes'; prefixes: readonly string[]; }>
    | Readonly<{ kind: 'expired'; maximumExpireAtTimestamp: number; }>
    | Readonly<{ kind: 'revision'; }>;

export async function readIndexedDbAdmissionSnapshot(
    db: IDBDatabase,
    storeName: string,
    selection: IndexedDbAdmissionSelection
): Promise<IndexedDbAdmissionSnapshot> {
    const transaction = db.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    const [rows, revisionValue] = await readIndexedDbTransaction(
        transaction,
        async () =>
            await Promise.all([
                readIndexedDbAdmissionSelection(store, selection),
                readIndexedDbRequest(store.get(AL_ADMISSION_REVISION_KEY))
            ])
    );
    return { stored: rows, revision: decodeIndexedDbAdmissionRevision(revisionValue) };
}

async function readIndexedDbAdmissionSelection(
    store: IDBObjectStore,
    selection: IndexedDbAdmissionSelection
): Promise<readonly IndexedDbAdmissionStoredRow[]> {
    switch (selection.kind) {
        case 'key': {
            const value = await readIndexedDbRequest(store.get(selection.key));
            return value === undefined
                ? []
                : [decodeIndexedDbAdmissionStoredRow(value, selection.key)];
        }
        case 'prefixes':
            return await collectIndexedDbAdmissionStoredValuesForPrefixes(
                store,
                selection.prefixes
            );
        case 'expired':
            return await readIndexedDbAdmissionRange(
                store.index(AL_ADMISSION_EXPIRY_INDEX_NAME),
                IDBKeyRange.upperBound(selection.maximumExpireAtTimestamp)
            );
        case 'revision':
            return [];
    }
}

async function collectIndexedDbAdmissionStoredValuesForPrefixes(
    store: IDBObjectStore,
    prefixes: readonly string[]
): Promise<readonly IndexedDbAdmissionStoredRow[]> {
    const stored = await Promise.all(
        removeCoveredIndexedDbPrefixes(prefixes).map((prefix) => readIndexedDbAdmissionPrefix(store, prefix))
    );
    return stored.flat();
}

function removeCoveredIndexedDbPrefixes(prefixes: readonly string[]): readonly string[] {
    const selected: string[] = [];
    for (const prefix of [...new Set(prefixes)].sort()) {
        if (!selected.some((candidate) => prefix.startsWith(candidate))) {
            selected.push(prefix);
        }
    }
    return selected;
}

async function readIndexedDbAdmissionPrefix(
    store: IDBObjectStore,
    prefix: string
): Promise<readonly IndexedDbAdmissionStoredRow[]> {
    return await new Promise((resolve, reject) => {
        const rows: IndexedDbAdmissionStoredRow[] = [];
        const request = store.openCursor(
            prefix.length === 0 ? undefined : IDBKeyRange.lowerBound(prefix)
        );
        request.onerror = () => reject(request.error ?? new Error('IndexedDB cursor read failed'));
        request.onsuccess = () => {
            try {
                const cursor = request.result;
                if (!cursor) {
                    resolve(rows);
                    return;
                }
                const key = requireStringKey(cursor.key);
                if (!key.startsWith(prefix)) {
                    resolve(rows);
                    return;
                }
                if (key !== AL_ADMISSION_REVISION_KEY) {
                    rows.push(decodeIndexedDbAdmissionStoredRow(cursor.value, key));
                }
                cursor.continue();
            }
            catch (error) {
                reject(error);
            }
        };
    });
}

async function readIndexedDbAdmissionRange(
    source: IDBObjectStore | IDBIndex,
    range: IDBKeyRange | undefined
): Promise<readonly IndexedDbAdmissionStoredRow[]> {
    const [values, keys] = await Promise.all([
        readIndexedDbRequest(source.getAll(range)),
        readIndexedDbRequest(source.getAllKeys(range))
    ]);
    const rows: IndexedDbAdmissionStoredRow[] = [];
    values.forEach((value, index) => {
        const key = requireStringKey(keys[index]);
        if (key !== AL_ADMISSION_REVISION_KEY) {
            rows.push(decodeIndexedDbAdmissionStoredRow(value, key));
        }
    });
    return rows;
}

function requireStringKey(key: IDBValidKey): string {
    if (typeof key !== 'string') {
        throw new ALAdmissionCorruptionError(String(key), new TypeError('Admission row key must be a string'));
    }
    return key;
}
