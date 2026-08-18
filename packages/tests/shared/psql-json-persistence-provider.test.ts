import { describe, expect, it } from 'vitest';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { PSqlJsonPersistenceProvider } from '@shared-server/postgres/runtime-state/PSqlJsonPersistenceProvider.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateRepositoryLike,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';

describe('PSqlJsonPersistenceProvider', () => {
    it('stores, lists, and removes values within a namespace', async () => {
        const repository = createRepository();
        const provider = new PSqlJsonPersistenceProvider<{ value: number }>(
            repository,
            'al-runtime:inbound:dedup',
        );

        await provider.setItem(
            'msg-1',
            { value: 1 },
            { expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP },
        );
        await provider.setItem(
            'msg-2',
            { value: 2 },
            { expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP },
        );

        expect(await provider.getItem('msg-1')).toEqual({ value: 1 });
        expect(await provider.getAllKeys()).toEqual(['msg-1', 'msg-2']);

        await provider.removeItem('msg-1');
        expect(await provider.getItem('msg-1')).toBeUndefined();
        expect(await provider.getAllKeys()).toEqual(['msg-2']);
    });

    it('lazy-evicts expired values', async () => {
        const repository = createRepository();
        const provider = new PSqlJsonPersistenceProvider<{ value: number }>(
            repository,
            'al-runtime:outbound:repair-attempts',
        );
        const now = Date.now();

        await provider.setItem('active', { value: 1 }, { expireAtTimestamp: now + 60_000 });
        await provider.setItem('expired', { value: 2 }, { expireAtTimestamp: now - 1 });

        expect(await provider.getItem('expired')).toBeUndefined();
        expect(await provider.getAllKeys()).toEqual(['active']);
    });

    it('deleteExpired only removes expired values in the current namespace', async () => {
        const repository = createRepository();
        const inbound = new PSqlJsonPersistenceProvider<{ value: number }>(
            repository,
            'al-runtime:inbound:ordering',
        );
        const outbound = new PSqlJsonPersistenceProvider<{ value: number }>(
            repository,
            'al-runtime:outbound:ordering',
        );
        const now = Date.now();

        await inbound.setItem('expired', { value: 1 }, { expireAtTimestamp: now - 1 });
        await inbound.setItem('active', { value: 2 }, { expireAtTimestamp: now + 60_000 });
        await outbound.setItem('expired', { value: 3 }, { expireAtTimestamp: now - 1 });

        expect(await inbound.deleteExpired()).toBe(1);
        expect(await inbound.getAllKeys()).toEqual(['active']);
        expect(await outbound.getAllKeys()).toEqual([]);
    });

    it('isolates values by namespace', async () => {
        const repository = createRepository();
        const inbound = new PSqlJsonPersistenceProvider<{ value: number }>(
            repository,
            'al-runtime:inbound:supersedence',
        );
        const outbound = new PSqlJsonPersistenceProvider<{ value: number }>(
            repository,
            'al-runtime:outbound:supersedence',
        );

        await inbound.setItem(
            'presence:room-1',
            { value: 1 },
            { expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP },
        );
        await outbound.setItem(
            'presence:room-1',
            { value: 2 },
            { expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP },
        );

        expect(await inbound.getItem('presence:room-1')).toEqual({ value: 1 });
        expect(await outbound.getItem('presence:room-1')).toEqual({ value: 2 });
    });
});

function createRepository(): RuntimeStateRepositoryLike {
    const data = new Map<string, RuntimeStateEntry>();

    return {
        async findEntry(namespace, key) {
            return data.get(`${namespace}:${key}`);
        },
        async findAllEntries(namespace) {
            return [...data.keys()]
                .filter((entryKey) => entryKey.startsWith(`${namespace}:`))
                .map((entryKey) => data.get(entryKey))
                .filter((entry): entry is RuntimeStateEntry => entry !== undefined)
                .sort((left, right) => left.key.localeCompare(right.key));
        },
        async upsert(namespace, key, value, expireAtTimestamp) {
            const compositeKey = `${namespace}:${key}`;
            const previousRevision = data.get(compositeKey)?.revision ?? 0;

            data.set(compositeKey, {
                key,
                value,
                expireAtTimestamp,
                updatedTimestamp: new Date().toISOString(),
                revision: previousRevision + 1,
            });
        },
        async deleteByKey(namespace, key) {
            data.delete(`${namespace}:${key}`);
        },
        async deleteExpired(namespace) {
            let deleted = 0;

            for (const [compositeKey, entry] of data.entries()) {
                if (!compositeKey.startsWith(`${namespace}:`)) {
                    continue;
                }

                if (entry.expireAtTimestamp > Date.now()) {
                    continue;
                }

                data.delete(compositeKey);
                deleted += 1;
            }

            return deleted;
        },
    };
}
