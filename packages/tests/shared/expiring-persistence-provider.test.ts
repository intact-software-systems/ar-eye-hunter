// @vitest-environment happy-dom

import '../setup-browser-indexeddb.ts';

import { IndexedDbStringPersistenceProvider } from '@shared/persistence/indexed-db-string-persistence-provider.ts';
import { openIndexedDbWithStore } from '@shared/persistence/open-indexed-db.ts';
import { InMemoryPersistenceProvider } from '@shared/persistence/PersistenceProvider.ts';
import { describe, expect, it, vi } from 'vitest';

describe('Expiring persistence providers', () => {
    it('lazy-evicts expired entries from InMemoryPersistenceProvider', async () => {
        const provider = new InMemoryPersistenceProvider<string, { value: number; }>();
        const now = Date.now();

        await provider.setItem('active', { value: 1 }, { expireAtTimestamp: now + 60_000 });
        await provider.setItem('expired', { value: 2 }, { expireAtTimestamp: now - 1 });

        expect(await provider.getItem('expired')).toBeUndefined();
        expect(await provider.getAllKeys()).toEqual(['active']);
        expect(await provider.getItem('active')).toEqual({ value: 1 });
    });

    it('deleteExpired removes only expired entries from InMemoryPersistenceProvider', async () => {
        const provider = new InMemoryPersistenceProvider<string, { value: number; }>();
        const now = Date.now();

        await provider.setItem('active', { value: 1 }, { expireAtTimestamp: now + 60_000 });
        await provider.setItem('expired-a', { value: 2 }, { expireAtTimestamp: now - 10 });
        await provider.setItem('expired-b', { value: 3 }, { expireAtTimestamp: now - 20 });

        expect(await provider.deleteExpired()).toBe(2);
        expect(await provider.getAllKeys()).toEqual(['active']);
    });

    it('lazy-evicts expired entries from IndexedDbStringPersistenceProvider', async () => {
        const provider = new IndexedDbStringPersistenceProvider<{ value: number; }>({
            dbName: `expiring-provider-${crypto.randomUUID()}`,
            keyPrefix: 'inbound'
        });
        const now = Date.now();

        await provider.setItem('active', { value: 1 }, { expireAtTimestamp: now + 60_000 });
        await provider.setItem('expired', { value: 2 }, { expireAtTimestamp: now - 1 });

        expect(await provider.getItem('expired')).toBeUndefined();
        expect(await provider.getAllKeys()).toEqual(['active']);
        expect(await provider.getItem('active')).toEqual({ value: 1 });
    });

    it('deleteExpired is scoped to the IndexedDB key prefix', async () => {
        const dbName = `expiring-provider-${crypto.randomUUID()}`;
        const inbound = new IndexedDbStringPersistenceProvider<{ value: number; }>({
            dbName,
            keyPrefix: 'inbound'
        });
        const outbound = new IndexedDbStringPersistenceProvider<{ value: number; }>({
            dbName,
            keyPrefix: 'outbound'
        });
        const now = Date.now();

        await inbound.setItem('expired', { value: 1 }, { expireAtTimestamp: now - 1 });
        await inbound.setItem('active', { value: 2 }, { expireAtTimestamp: now + 60_000 });
        await outbound.setItem('expired', { value: 3 }, { expireAtTimestamp: now - 1 });

        expect(await inbound.deleteExpired()).toBe(1);
        expect(await inbound.getAllKeys()).toEqual(['active']);

        expect(await outbound.getItem('expired')).toBeUndefined();
        expect(await outbound.getAllKeys()).toEqual([]);
    });

    it('rejects a persisted row without the required write token', async () => {
        const dbName = `missing-write-token-${crypto.randomUUID()}`;
        const storeName = 'entries';
        const database = await openIndexedDbWithStore(dbName, { name: storeName, keyPath: 'key' });
        const transaction = database.transaction(storeName, 'readwrite');
        transaction.objectStore(storeName).put({
            key: 'inbound:expired',
            value: { value: 1 },
            expireAtTimestamp: Date.now() - 1
        });
        await new Promise<void>((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onabort = () => reject(transaction.error);
        });
        database.close();

        const provider = new IndexedDbStringPersistenceProvider<{ value: number; }>({
            dbName,
            storeName,
            keyPrefix: 'inbound'
        });
        await expect(provider.getItem('expired')).rejects.toThrow(
            'IndexedDB persistence row fields are invalid'
        );
    });

    it.each(['getItem', 'getAllKeys', 'deleteExpired'] as const)(
        '%s surfaces an expiry conflict without retrying or deleting the refreshed value',
        async (operation) => {
            const dbName = `expiry-conflict-${crypto.randomUUID()}`;
            const storeName = 'entries';
            const provider = new IndexedDbStringPersistenceProvider<{ value: number; }>({
                dbName,
                storeName,
                keyPrefix: 'inbound'
            });
            const now = Date.now();
            await provider.setItem('expired', { value: 1 }, { expireAtTimestamp: now - 1 });

            const openTransaction = IDBDatabase.prototype.transaction;
            let cleanupAttempts = 0;
            const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
                this: IDBDatabase,
                storeNames,
                mode,
                options
            ) {
                if (this.name === dbName && mode === 'readwrite') {
                    cleanupAttempts += 1;
                    if (cleanupAttempts === 1) {
                        // Queue a real competing write after the expiry read, before its cleanup transaction.
                        const refresh = openTransaction.call(this, storeNames, mode, options);
                        refresh.objectStore(storeName).put({
                            key: 'inbound:expired',
                            value: { value: 2 },
                            expireAtTimestamp: now + 60_000,
                            writeToken: 'replacement'
                        });
                    }
                }
                return openTransaction.call(this, storeNames, mode, options);
            });
            try {
                const cleanup = operation === 'getItem'
                    ? provider.getItem('expired')
                    : operation === 'getAllKeys'
                    ? provider.getAllKeys()
                    : provider.deleteExpired();

                await expect(cleanup).rejects.toThrow('IndexedDB persistence cleanup conflicted');
                expect(cleanupAttempts).toBe(1);
                expect(await provider.getItem('expired')).toEqual({ value: 2 });
                expect(await provider.getAllKeys()).toEqual(['expired']);
            }
            finally {
                transactions.mockRestore();
            }
        }
    );

    it.each(['getItem', 'getAllKeys', 'deleteExpired'] as const)(
        '%s preserves a same-expiry replacement that follows its read',
        async (operation) => {
            const dbName = `same-expiry-conflict-${crypto.randomUUID()}`;
            const storeName = 'entries';
            const provider = new IndexedDbStringPersistenceProvider<{ value: number; }>({
                dbName,
                storeName,
                keyPrefix: 'inbound'
            });
            const expireAtTimestamp = Date.now() - 1;
            await provider.setItem('expired', { value: 1 }, { expireAtTimestamp });

            const openTransaction = IDBDatabase.prototype.transaction;
            let cleanupAttempts = 0;
            const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
                this: IDBDatabase,
                storeNames,
                mode,
                options
            ) {
                if (this.name === dbName && mode === 'readwrite') {
                    cleanupAttempts += 1;
                    if (cleanupAttempts === 1) {
                        const replacement = openTransaction.call(this, storeNames, mode, options);
                        replacement.objectStore(storeName).put({
                            key: 'inbound:expired',
                            value: { value: 2 },
                            expireAtTimestamp,
                            writeToken: 'replacement'
                        });
                    }
                }
                return openTransaction.call(this, storeNames, mode, options);
            });
            try {
                const cleanup = operation === 'getItem'
                    ? provider.getItem('expired')
                    : operation === 'getAllKeys'
                    ? provider.getAllKeys()
                    : provider.deleteExpired();

                await expect(cleanup).rejects.toThrow('IndexedDB persistence cleanup conflicted');
                expect(cleanupAttempts).toBe(1);
                expect(await readRawValue(dbName, storeName, 'inbound:expired')).toMatchObject({
                    value: { value: 2 },
                    expireAtTimestamp,
                    writeToken: 'replacement'
                });
            }
            finally {
                transactions.mockRestore();
            }
        }
    );
});

async function readRawValue(
    dbName: string,
    storeName: string,
    key: string
): Promise<IDBRequest['result']> {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    });
    try {
        return await new Promise((resolve, reject) => {
            const request = database.transaction(storeName).objectStore(storeName).get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error ?? new Error('IndexedDB get failed'));
        });
    }
    finally {
        database.close();
    }
}
