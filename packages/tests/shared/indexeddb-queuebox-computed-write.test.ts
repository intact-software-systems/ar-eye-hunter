// @vitest-environment happy-dom

import '../setup-browser-indexeddb.ts';

import { Temporal } from '@js-temporal/polyfill';
import { openIndexedDbWithStore } from '@shared/persistence/openIndexedDb.ts';
import {
    decodeStoredResourceEntry,
    encodeStoredResourceEntry,
    type StoredResourceEntry
} from '@shared/queuebox/indexed-db-queue-box-entry.ts';
import { computeIndexedDbFairnessReservation } from '@shared/queuebox/indexed-db-queue-box-fairness.ts';
import { readStoredQueueEntry } from '@shared/queuebox/indexed-db-queue-box-store.ts';
import { writeComputedIndexedDbQueueMutations } from '@shared/queuebox/indexed-db-queue-box-write.ts';
import { EntityStatus, NEVER_EXPIRE_TS, ResourceEntry, toKeyAsString } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it, vi } from 'vitest';

describe('IndexedDbQueueBox computed writes', () => {
    it.each(
        [
            ['audit.date', (stored: StoredResourceEntry) => ({ ...stored, audit: { ...stored.audit, date: 'not-a-time' } })],
            ['audit.createdTs', (stored: StoredResourceEntry) => ({ ...stored, audit: { ...stored.audit, createdTs: 'not-a-time' } })],
            ['audit.expiryTs', (stored: StoredResourceEntry) => ({ ...stored, audit: { ...stored.audit, expiryTs: 'not-a-time' } })],
            ['dequeueAudit.startTs', (stored: StoredResourceEntry) => ({
                ...stored,
                dequeueAudit: { ...stored.dequeueAudit, startTs: 'not-a-time' }
            })],
            ['dequeueAudit.endTs', (stored: StoredResourceEntry) => ({
                ...stored,
                dequeueAudit: { ...stored.dequeueAudit, endTs: 'not-a-time' }
            })],
            ['dequeueAudit.nextTs', (stored: StoredResourceEntry) => ({
                ...stored,
                dequeueAudit: { ...stored.dequeueAudit, nextTs: 'not-a-time' }
            })]
        ] as const
    )('rejects malformed persisted %s instead of substituting a fallback', (_field, corrupt) => {
        const stored = encodeStoredResourceEntry(createEntry('malformed-timestamp'), 0);

        expect(() => decodeStoredResourceEntry(corrupt(stored))).toThrow();
    });

    it('allows only one writer to commit a computed revision', async () => {
        const storeName = 'entries';
        const db = await openIndexedDbWithStore(
            `indexeddb-computed-write-${crypto.randomUUID()}`,
            { name: storeName, keyPath: 'keyString' }
        );
        const initial = createEntry('initial');
        const keyString = toKeyAsString(initial.key);
        await writeComputedIndexedDbQueueMutations(db, storeName, [{
            keyString,
            value: encodeStoredResourceEntry(initial, 0)
        }]);

        const first = createEntry('first');
        const second = createEntry('second');
        const outcomes = await Promise.all([
            writeComputedIndexedDbQueueMutations(db, storeName, [{
                keyString,
                expectedRevision: 0,
                value: encodeStoredResourceEntry(first, 1)
            }]),
            writeComputedIndexedDbQueueMutations(db, storeName, [{
                keyString,
                expectedRevision: 0,
                value: encodeStoredResourceEntry(second, 1)
            }])
        ]);

        expect(outcomes.toSorted()).toEqual([false, true]);
        const stored = await readStoredQueueEntry(db, storeName, keyString);
        expect(stored?.revision).toBe(1);
        expect([first.resource, second.resource]).toContain(stored?.resource);
    });

    it('rolls back every computed mutation when one comparison conflicts', async () => {
        const storeName = 'entries';
        const db = await openIndexedDbWithStore(
            `indexeddb-computed-batch-${crypto.randomUUID()}`,
            { name: storeName, keyPath: 'keyString' }
        );
        const first = createEntry('first', 'first-row');
        const second = createEntry('second', 'second-row');
        const firstKey = toKeyAsString(first.key);
        const secondKey = toKeyAsString(second.key);
        await writeComputedIndexedDbQueueMutations(db, storeName, [
            { keyString: firstKey, value: encodeStoredResourceEntry(first, 0) },
            { keyString: secondKey, value: encodeStoredResourceEntry(second, 0) }
        ]);

        const committed = await writeComputedIndexedDbQueueMutations(db, storeName, [
            {
                keyString: firstKey,
                expectedRevision: 0,
                value: encodeStoredResourceEntry(createEntry('changed-first', 'first-row'), 1)
            },
            {
                keyString: secondKey,
                expectedRevision: 99,
                value: encodeStoredResourceEntry(createEntry('changed-second', 'second-row'), 100)
            }
        ]);

        expect(committed).toBe(false);
        expect((await readStoredQueueEntry(db, storeName, firstKey))?.resource).toBe(first.resource);
        expect((await readStoredQueueEntry(db, storeName, secondKey))?.resource).toBe(second.resource);
    });

    it('computes fairness ordering without reading the IndexedDB global', () => {
        const dueAt = Temporal.Instant.from('2026-01-01T12:00:00Z');
        const stored = ['z-type', 'a-type'].map((typeId) => ({
            ...encodeStoredResourceEntry(createEntry(typeId, typeId), 0),
            typeId,
            status: EntityStatus.RETRY,
            fairnessDueEpochMs: Number(dueAt.epochMilliseconds),
            dequeueAudit: {
                attempts: 0,
                nextTs: dueAt.toString()
            }
        }));
        vi.stubGlobal('indexedDB', undefined);
        try {
            const computed = computeIndexedDbFairnessReservation({
                entriesByType: new Map([
                    ['z-type', [stored[0]]],
                    ['a-type', [stored[1]]]
                ]),
                maxAttempts: 3,
                maxToReserve: 1,
                maxToScan: 2,
                now: dueAt,
                requestedTypes: ['z-type', 'a-type']
            });

            expect([...computed.result.values()][0]?.entry.typeId).toBe('a-type');
        }
        finally {
            vi.unstubAllGlobals();
        }
    });
});

function createEntry(resource: string, resourceId: string = 'shared-resource'): ResourceEntry {
    return {
        key: {
            topicId: 'computed-write',
            resourceId,
            contextId: 'test'
        },
        resource,
        typeId: 'computed-write',
        audit: {
            date: Temporal.PlainTime.from('12:00:00'),
            createdBy: 'test',
            createdTs: Temporal.PlainDateTime.from('2026-01-01T12:00:00'),
            expiryTs: NEVER_EXPIRE_TS
        },
        status: EntityStatus.NEW,
        dequeueAudit: { attempts: 0 }
    };
}
