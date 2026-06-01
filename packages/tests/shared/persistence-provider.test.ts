// @vitest-environment happy-dom

import { Temporal } from '@js-temporal/polyfill';
import '../setup-browser-indexeddb.ts';

import { describe, expect, it } from 'vitest';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import { IndexedDbQueueBox } from '@shared/queuebox/IndexedDbQueueBox.ts';
import { EntityStatus, Key, NEVER_EXPIRE_TS, ResourceEntry, } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxResourceEntryRepository } from '@shared/queuebox/QueueBoxTypes.ts';

describe('PersistenceProvider (QueueBox implementations)', () => {

    const createEntry = (resourceId: string): ResourceEntry => ({
        key: {
            topicId: 'test-topic',
            resourceId,
            contextId: 'test-ctx',
        },
        resource: JSON.stringify({ id: resourceId }),
        typeId: 'test-type',
        audit: {
            date: Temporal.Now.plainTimeISO(),
            createdBy: 'test-user',
            createdTs: Temporal.Now.plainDateTimeISO(),
            expiryTs: NEVER_EXPIRE_TS,
        },
        status: EntityStatus.NEW,
        dequeueAudit: {
            attempts: 0,
        },
    });

    const runSharedTests = (setup: () => Promise<QueueBoxResourceEntryRepository>) => {
        it('should store and retrieve an item', async () => {
            const provider = await setup();
            const entry = createEntry('item-1');

            await provider.setItem(entry.key, entry, { expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP });
            const retrieved = await provider.getItem(entry.key);

            expect(retrieved).toBeDefined();
            expect(retrieved?.key).toEqual(entry.key);
            expect(retrieved?.resource).toBe(entry.resource);
        });

        it('should return undefined for non-existent item', async () => {
            const provider = await setup();
            const key: Key = { topicId: 'none', resourceId: 'none', contextId: 'none' };

            const retrieved = await provider.getItem(key);
            expect(retrieved).toBeUndefined();
        });

        it('should remove an item', async () => {
            const provider = await setup();
            const entry = createEntry('item-to-remove');

            await provider.setItem(entry.key, entry, { expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP });
            await provider.removeItem(entry.key);

            const retrieved = await provider.getItem(entry.key);
            expect(retrieved).toBeUndefined();
        });

        it('should store the value under the provided key', async () => {
            const provider = await setup();
            const original = createEntry('item-original');
            const targetKey: Key = {
                topicId: 'override-topic',
                resourceId: 'override-resource',
                contextId: 'override-context',
            };

            await provider.setItem(targetKey, original, { expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP });

            const stored = await provider.getItem(targetKey);
            const previousKeyLookup = await provider.getItem(original.key);

            expect(stored?.key).toEqual(targetKey);
            expect(previousKeyLookup).toBeUndefined();
        });

        it('should return all keys', async () => {
            const provider = await setup();
            const entry1 = createEntry('item-1');
            const entry2 = createEntry('item-2');

            await provider.setItem(entry1.key, entry1, { expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP });
            await provider.setItem(entry2.key, entry2, { expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP });

            const keys = await provider.getAllKeys();
            expect(keys).toHaveLength(2);
            expect(keys).toContainEqual(entry1.key);
            expect(keys).toContainEqual(entry2.key);
        });
    };

    describe('InMemoryQueueBox', () => {
        runSharedTests(async () => new InMemoryQueueBox());
    });

    describe('IndexedDbQueueBox', () => {
        runSharedTests(async () => new IndexedDbQueueBox({ dbName: `test-db-${crypto.randomUUID()}` }));

        it('should persist items across instances', async () => {
            const dbName = `persist-test-${crypto.randomUUID()}`;
            const provider1 = new IndexedDbQueueBox({ dbName });
            const entry = createEntry('cross-instance-item');

            await provider1.setItem(entry.key, entry, { expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP });

            const provider2 = new IndexedDbQueueBox({ dbName });
            const retrieved = await provider2.getItem(entry.key);

            expect(retrieved).toBeDefined();
            expect(retrieved?.key).toEqual(entry.key);
        });
    });
});
