// @vitest-environment happy-dom

import '../setup-browser-indexeddb.ts';

import { IndexedDbStringPersistenceProvider, InMemoryPersistenceProvider } from '@shared/mod.ts';
import { describe, expect, it } from 'vitest';

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
});
