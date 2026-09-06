// @vitest-environment happy-dom

import '../setup-browser-indexeddb.ts';

import { Temporal } from '@js-temporal/polyfill';
import { openIndexedDbWithStores } from '@shared/persistence/open-indexed-db.ts';
import { computeIndexedDbFairnessReservation } from '@shared/queuebox/compute-indexed-db-fairness-reservation.ts';
import {
    decodeStoredResourceEntry,
    encodeStoredResourceEntry,
    type StoredResourceEntry
} from '@shared/queuebox/indexed-db-queue-box-entry-codec.ts';
import {
    computeIndexedDbQueuePut
} from '@shared/queuebox/indexed-db-queue-box-entry.ts';
import { readStoredQueueEntry } from '@shared/queuebox/indexed-db-queue-box-store.ts';
import { EntityStatus, NEVER_EXPIRE_TS, ResourceEntry, toKeyAsString } from '@shared/queuebox/ResourceEntry.ts';
import { writeComputedIndexedDbQueueMutations } from '@shared/queuebox/write-computed-indexed-db-queue-mutations.ts';
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
        const db = await openIndexedDbWithStores(
            `indexeddb-computed-write-${crypto.randomUUID()}`,
            [{ name: storeName, keyPath: 'keyString' }]
        );
        const initial = createEntry('initial');
        const keyString = toKeyAsString(initial.key);
        const initialWrite = computeIndexedDbQueuePut(undefined, initial);
        await writeComputedIndexedDbQueueMutations(db, storeName, [initialWrite]);

        const first = createEntry('first');
        const second = createEntry('second');
        const outcomes = await Promise.all([
            writeComputedIndexedDbQueueMutations(db, storeName, [
                computeIndexedDbQueuePut(initialWrite.value, first)
            ]),
            writeComputedIndexedDbQueueMutations(db, storeName, [
                computeIndexedDbQueuePut(initialWrite.value, second)
            ])
        ]);

        expect(outcomes.toSorted()).toEqual([false, true]);
        const stored = await readStoredQueueEntry(db, storeName, keyString);
        expect(stored?.revision).toBe(1);
        expect([first.resource, second.resource]).toContain(stored?.resource);
    });

    it('rolls back every computed mutation when one comparison conflicts', async () => {
        const storeName = 'entries';
        const db = await openIndexedDbWithStores(
            `indexeddb-computed-batch-${crypto.randomUUID()}`,
            [{ name: storeName, keyPath: 'keyString' }]
        );
        const first = createEntry('first', 'first-row');
        const second = createEntry('second', 'second-row');
        const firstKey = toKeyAsString(first.key);
        const secondKey = toKeyAsString(second.key);
        const firstInsert = computeIndexedDbQueuePut(undefined, first);
        const secondInsert = computeIndexedDbQueuePut(undefined, second);
        await writeComputedIndexedDbQueueMutations(db, storeName, [firstInsert, secondInsert]);

        const firstUpdate = computeIndexedDbQueuePut(
            firstInsert.value,
            createEntry('changed-first', 'first-row')
        );
        const staleSecondUpdate = computeIndexedDbQueuePut(
            secondInsert.value,
            createEntry('changed-second', 'second-row')
        );
        const concurrentSecond = createEntry('concurrent-second', 'second-row');
        await writeComputedIndexedDbQueueMutations(db, storeName, [
            computeIndexedDbQueuePut(
                secondInsert.value,
                concurrentSecond
            )
        ]);

        const committed = await writeComputedIndexedDbQueueMutations(db, storeName, [
            firstUpdate,
            staleSecondUpdate
        ]);

        expect(committed).toBe(false);
        expect((await readStoredQueueEntry(db, storeName, firstKey))?.resource).toBe(first.resource);
        expect((await readStoredQueueEntry(db, storeName, secondKey))?.resource).toBe(
            concurrentSecond.resource
        );
    });

    it('compares only the stored revision inside the write transaction', async () => {
        const storeName = 'entries';
        const db = await openIndexedDbWithStores(
            `indexeddb-revision-comparison-${crypto.randomUUID()}`,
            [{ name: storeName, keyPath: 'keyString' }]
        );
        const initial = computeIndexedDbQueuePut(undefined, createEntry('initial'));
        await writeComputedIndexedDbQueueMutations(db, storeName, [initial]);
        const computed = computeIndexedDbQueuePut(initial.value, createEntry('replacement'));
        const transactionImplementation = IDBDatabase.prototype.transaction;
        let writeTransactionOpen = false;
        const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
            this: IDBDatabase,
            ...args: Parameters<IDBDatabase['transaction']>
        ) {
            const transaction = Reflect.apply(transactionImplementation, this, args);
            if (args[1] === 'readwrite') {
                writeTransactionOpen = true;
                transaction.addEventListener('complete', () => {
                    writeTransactionOpen = false;
                });
                transaction.addEventListener('abort', () => {
                    writeTransactionOpen = false;
                });
            }
            return transaction;
        });
        const parseInstant = Temporal.Instant.from;
        const instantParsing = vi.spyOn(Temporal.Instant, 'from').mockImplementation((value) => {
            if (writeTransactionOpen) {
                throw new Error('Timestamp parsing must finish before the write transaction');
            }
            return parseInstant(value);
        });
        try {
            await expect(writeComputedIndexedDbQueueMutations(db, storeName, [computed]))
                .resolves.toBe(true);
        }
        finally {
            instantParsing.mockRestore();
            transactions.mockRestore();
        }
    });

    it('rejects a fabricated mutation whose key differs from its stored value before opening a transaction', async () => {
        const storeName = 'entries';
        const db = await openIndexedDbWithStores(
            `indexeddb-invalid-computed-write-${crypto.randomUUID()}`,
            [{ name: storeName, keyPath: 'keyString' }]
        );
        const computed = computeIndexedDbQueuePut(undefined, createEntry('value', 'stored-key'));
        const transactionForbidden = new Proxy(db, {
            get: (target, property, receiver) => {
                if (property === 'transaction') {
                    throw new Error('Invalid computed writes must not open a transaction');
                }
                return Reflect.get(target, property, receiver);
            }
        });

        await expect(writeComputedIndexedDbQueueMutations(transactionForbidden, storeName, [{
            ...computed,
            keyString: toKeyAsString(createEntry('value', 'other-key').key)
        }])).rejects.toThrow('mutation key differs');
    });

    it.each(['mutation', 'expected state'] as const)(
        'rejects an unknown %s kind before entering a transaction',
        async (field) => {
            const storeName = 'entries';
            const db = await openIndexedDbWithStores(
                `indexeddb-invalid-kind-${crypto.randomUUID()}`,
                [{ name: storeName, keyPath: 'keyString' }]
            );
            const initial = computeIndexedDbQueuePut(undefined, createEntry('preserved'));
            await writeComputedIndexedDbQueueMutations(db, storeName, [initial]);
            const next = computeIndexedDbQueuePut(initial.value, createEntry('replacement'));
            const invalid = field === 'mutation'
                ? { ...next, kind: 'unsupported' as never }
                : { ...next, expected: { kind: 'unsupported' as never, revision: 0 } };
            const transactionForbidden = new Proxy(db, {
                get: (target, property, receiver) => {
                    if (property === 'transaction') {
                        throw new Error('Invalid computed writes must not open a transaction');
                    }
                    return Reflect.get(target, property, receiver);
                }
            });
            try {
                await expect(writeComputedIndexedDbQueueMutations(transactionForbidden, storeName, [invalid]))
                    .rejects.toThrow(`queue ${field}`);
                expect((await readStoredQueueEntry(db, storeName, initial.keyString))?.resource).toBe('preserved');
            }
            finally {
                db.close();
            }
        }
    );

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
