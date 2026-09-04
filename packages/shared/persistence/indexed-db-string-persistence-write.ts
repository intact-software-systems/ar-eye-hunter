import { waitForIndexedDbTransaction } from './indexed-db-request.ts';

export type StoredIndexedDbValue<Value> = Readonly<{
    key: string;
    value: Value;
    expireAtTimestamp: number;
    writeToken: string;
}>;

export function decodeStoredIndexedDbValue<Value>(
    value: unknown,
    expectedKey?: string
): StoredIndexedDbValue<Value> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('IndexedDB persistence row must be a record');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const fields = Reflect.ownKeys(value);
    const requiredFields = ['key', 'value', 'expireAtTimestamp', 'writeToken'];
    if (
        fields.length !== requiredFields.length ||
        requiredFields.some((field) => !Object.hasOwn(descriptors, field))
    ) {
        throw new TypeError('IndexedDB persistence row fields are invalid');
    }
    for (const field of requiredFields) {
        const descriptor = descriptors[field];
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError('IndexedDB persistence row must contain only data fields');
        }
    }
    const key = descriptors.key?.value;
    if (typeof key !== 'string' || (expectedKey !== undefined && key !== expectedKey)) {
        throw new TypeError('IndexedDB persistence key is invalid');
    }
    const expireAtTimestamp = descriptors.expireAtTimestamp?.value;
    if (typeof expireAtTimestamp !== 'number' || !Number.isFinite(expireAtTimestamp)) {
        throw new TypeError('IndexedDB persistence expiry must be a finite number');
    }
    const writeToken = descriptors.writeToken?.value;
    if (typeof writeToken !== 'string') {
        throw new TypeError('IndexedDB persistence write token must be a string');
    }
    return {
        key,
        value: descriptors.value?.value as Value,
        expireAtTimestamp,
        writeToken
    };
}

export type ComputedIndexedDbStringDeletion = Readonly<{
    key: string;
    expectedExpireAtTimestamp: number;
    expectedWriteToken: string;
}>;

export async function writeComputedIndexedDbStringValue<Value>(
    db: IDBDatabase,
    storeName: string,
    stored: StoredIndexedDbValue<Value>
): Promise<void> {
    const transaction = db.transaction(storeName, 'readwrite');
    const completed = waitForIndexedDbTransaction(transaction);
    transaction.objectStore(storeName).put(stored);
    await completed;
}

export async function removeComputedIndexedDbStringValue(
    db: IDBDatabase,
    storeName: string,
    key: string
): Promise<void> {
    const transaction = db.transaction(storeName, 'readwrite');
    const completed = waitForIndexedDbTransaction(transaction);
    transaction.objectStore(storeName).delete(key);
    await completed;
}

export async function deleteComputedIndexedDbStringValues(
    db: IDBDatabase,
    storeName: string,
    deletions: readonly ComputedIndexedDbStringDeletion[]
): Promise<boolean> {
    if (deletions.length === 0) {
        return true;
    }

    return await new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        let conflict = false;
        tx.oncomplete = () => resolve(true);
        tx.onabort = () => {
            if (conflict) {
                resolve(false);
                return;
            }
            reject(tx.error ?? new Error('IndexedDB computed delete aborted'));
        };
        for (const deletion of deletions) {
            const getRequest = store.get(deletion.key);
            getRequest.onsuccess = () => {
                if (conflict) {
                    return;
                }
                const current = getRequest.result as
                    | Readonly<{
                        expireAtTimestamp: number;
                        writeToken: string;
                    }>
                    | undefined;
                if (
                    current?.expireAtTimestamp !== deletion.expectedExpireAtTimestamp ||
                    current.writeToken !== deletion.expectedWriteToken
                ) {
                    conflict = true;
                    tx.abort();
                    return;
                }
                store.delete(deletion.key);
            };
        }
    });
}
