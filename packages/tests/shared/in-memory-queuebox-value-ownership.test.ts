import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { EnqueuedType } from '@shared/api/api-config.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import {
    EntityStatus,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';

describe('InMemoryQueueBox value ownership', () => {
    it('commits no insertion when any member of a batch has a live winner', async () => {
        const queue = new InMemoryQueueBox();
        const existing = createEntry();
        await queue.enqueue(existing);
        const fresh = { ...createEntry(), key: { ...existing.key, resourceId: 'fresh' } };
        expect(queue.writeIfAllObserved([{ expected: undefined, entry: fresh }, { expected: undefined, entry: { ...existing, resource: 'loser' } }])).toBe(
            false
        );
        expect(await queue.getItem(fresh.key)).toBeUndefined();
        expect(await queue.getItem(existing.key)).toEqual(existing);
    });

    it('rejects duplicate batch identities before recording any work', async () => {
        const queue = new InMemoryQueueBox();
        const entry = createEntry();
        expect(() => queue.writeIfAllObserved([{ expected: undefined, entry }, { expected: undefined, entry: { ...entry, resource: 'other' } }])).toThrow(
            'duplicate'
        );
        expect(await queue.getAllKeys()).toEqual([]);
    });

    it('keeps the computed input and read observation unchanged when work is reserved', async () => {
        const entry = createEntry();
        const queue = new InMemoryQueueBox();
        await queue.enqueue(entry);
        const observed = await queue.getItem(entry.key);

        const reserved = firstValue(
            await queue.reserveEntries(
                new Set([entry.typeId]),
                new Set([EntityStatus.NEW]),
                1
            )
        );

        expect(entry).toEqual(createEntry());
        expect(observed).toEqual(createEntry());
        expect(reserved).toMatchObject({
            status: EntityStatus.RESERVED,
            dequeueAudit: { attempts: 1 }
        });
        expect(
            await queue.replaceIfObserved(observed!, {
                ...entry,
                resource: 'stale-computation'
            })
        ).toBeNull();
        expect(await queue.getItem(entry.key)).toEqual(reserved);
    });

    it('rejects a stale worker release after timeout recovery without changing its observation', async () => {
        const entry = {
            ...createEntry(),
            status: EntityStatus.RESERVED,
            dequeueAudit: {
                attempts: 1,
                startTs: Temporal.Instant.from('2020-01-01T00:00:00Z')
            }
        };
        const queue = new InMemoryQueueBox();
        await queue.enqueue(entry);
        const observed = await queue.getItem(entry.key);
        const reclaimed = firstValue(
            await queue.reserveTimeoutEntries(
                new Set([entry.typeId]),
                { maxToReserve: 1, maxAttempts: 3 },
                Temporal.Duration.from({ minutes: 5 })
            )
        );

        expect(observed?.dequeueAudit.attempts).toBe(1);
        expect(entry.dequeueAudit.attempts).toBe(1);
        expect(reclaimed.dequeueAudit.attempts).toBe(2);
        await expect(queue.releaseEntries([observed!], {
            status: EntityStatus.COMPLETED,
            delayMs: null
        })).rejects.toMatchObject({ code: 'resource-inbox-lost-reservation' });
        expect(await queue.getItem(entry.key)).toEqual(reclaimed);
    });

    it.each(
        [
            'constructor',
            'enqueue',
            'enqueueIfAbsent',
            'writeIfAllObserved',
            'tryWriteIfAbsentOrReplaceExpired',
            'replaceIfObserved',
            'setItem'
        ] as const
    )('owns the value accepted through %s', async (operation) => {
        const entry = createEntry();
        const queue = new InMemoryQueueBox(
            operation === 'constructor' ? new Map([[entry.key, entry]]) : new Map()
        );
        switch (operation) {
            case 'constructor':
                break;
            case 'enqueue':
                await queue.enqueue(entry);
                break;
            case 'enqueueIfAbsent':
                await queue.enqueueIfAbsent(entry);
                break;
            case 'writeIfAllObserved':
                expect(queue.writeIfAllObserved([{ expected: undefined, entry }])).toBe(true);
                break;
            case 'tryWriteIfAbsentOrReplaceExpired':
                await queue.tryWriteIfAbsentOrReplaceExpired(entry);
                break;
            case 'replaceIfObserved':
                await queue.enqueue(createEntry());
                expect(await queue.replaceIfObserved(createEntry(), entry)).toEqual(entry);
                break;
            case 'setItem':
                await queue.setItem(entry.key, entry, {
                    expireAtTimestamp: entry.audit.expiryTs.epochMilliseconds
                });
                break;
        }

        entry.status = EntityStatus.COMPLETED;
        entry.dequeueAudit.attempts = 99;
        entry.key.contextId = 'changed-context';
        entry.audit.createdBy = 'changed-audit';
        entry.db.id = 'changed-db-id';

        expect(await queue.getItem(createEntry().key)).toEqual(createEntry());
        expect(await queue.getItem(entry.key)).toBeUndefined();
    });

    it('does not expose stored values through reads or duplicate enqueue results', async () => {
        const queue = new InMemoryQueueBox();
        const entry = createEntry();
        const inserted = await queue.enqueueIfAbsent(entry);
        const duplicate = await queue.enqueueIfAbsent(createEntry());
        const observed = await queue.getItem(entry.key);
        for (const returned of [inserted, duplicate, observed!]) {
            returned.status = EntityStatus.FAILED;
            Object.assign(returned.key, { contextId: 'changed-context' });
            Object.assign(returned.audit, { createdBy: 'changed-audit' });
            Object.assign(returned.dequeueAudit, { attempts: 99 });
            Object.assign(returned.db!, { id: 'changed-db-id' });
        }

        expect(await queue.getItem(entry.key)).toEqual(createEntry());
    });

    it('keeps the displaced observation unchanged when that same value is enqueued again', async () => {
        const queue = new InMemoryQueueBox();
        const entry = createEntry();
        await queue.enqueue(entry);
        const previous = await queue.enqueue(entry);
        previous!.status = EntityStatus.FAILED;

        expect(await queue.getItem(entry.key)).toEqual(createEntry());
    });

    it.each(['reservation', 'timeout', 'fairness', 'finalization'] as const)(
        'keeps %s results outside queue ownership',
        async (operation) => {
            const entry = createEntry();
            const staleTime = Temporal.Instant.from('2020-01-01T00:00:00Z');
            const queue = new InMemoryQueueBox();
            await queue.enqueue({
                ...entry,
                status: operation === 'reservation'
                    ? EntityStatus.NEW
                    : operation === 'fairness'
                    ? EntityStatus.RETRY
                    : EntityStatus.RESERVED,
                dequeueAudit: {
                    attempts: operation === 'finalization' ? 1 : 0,
                    startTs: staleTime,
                    nextTs: staleTime
                }
            });

            let reserved: ResourceEntry;
            switch (operation) {
                case 'reservation':
                    reserved = firstValue(
                        await queue.reserveEntries(
                            new Set([entry.typeId]),
                            new Set([EntityStatus.NEW]),
                            1
                        )
                    );
                    break;
                case 'timeout':
                    reserved = firstValue(
                        await queue.reserveTimeoutEntries(
                            new Set([entry.typeId]),
                            1,
                            Temporal.Duration.from({ minutes: 5 })
                        )
                    );
                    break;
                case 'fairness':
                    reserved = firstValue(
                        await queue.reserveOverdueRetryEntries(
                            new Set([entry.typeId]),
                            staleTime.epochMilliseconds,
                            1
                        )
                    ).entry;
                    break;
                case 'finalization':
                    reserved = firstValue(
                        await queue.reserveRetryExhaustionFinalizations(
                            new Set([entry.typeId]),
                            { processingAttempts: 1, maxToReserve: 1, staleAfterMs: 1 }
                        )
                    ).entry;
                    break;
            }

            const observed = await queue.getItem(entry.key);
            reserved.status = EntityStatus.FAILED;
            Object.assign(reserved.dequeueAudit, { attempts: 99 });
            Object.assign(reserved.audit, { createdBy: 'changed-audit' });
            expect(await queue.getItem(entry.key)).toEqual(observed);
            expect(await queue.getItem(entry.key)).toMatchObject({
                status: EntityStatus.RESERVED,
                dequeueAudit: { attempts: operation === 'finalization' ? 2 : 1 }
            });
        }
    );

    it('keeps release results separate, including already completed handler work', async () => {
        const entry = { ...createEntry(), status: EntityStatus.RESERVED };
        const queue = new InMemoryQueueBox();
        await queue.enqueue(entry);
        const completed = firstValue(
            await queue.releaseEntries([entry], {
                status: EntityStatus.COMPLETED,
                delayMs: null
            })
        );
        const repeated = firstValue(
            await queue.releaseEntries([entry], {
                status: EntityStatus.COMPLETED,
                delayMs: null
            })
        );

        completed.status = EntityStatus.FAILED;
        repeated.status = EntityStatus.FAILED;
        Object.assign(repeated.dequeueAudit, { attempts: 99 });
        expect(await queue.getItem(entry.key)).toMatchObject({
            status: EntityStatus.COMPLETED,
            dequeueAudit: { attempts: 0 }
        });
    });
});

function createEntry() {
    return {
        key: { topicId: 'alm', resourceId: 'message-1', contextId: 'session-1' },
        resource: '{"message":"hello"}',
        typeId: EnqueuedType.APP_INBOX,
        audit: {
            date: Temporal.PlainTime.from('12:00:00'),
            createdBy: 'sender-1',
            createdTs: Temporal.PlainDateTime.from('2020-01-01T12:00:00'),
            expiryTs: Temporal.Instant.from('9999-12-31T23:59:59Z')
        },
        status: EntityStatus.NEW as EntityStatus,
        dequeueAudit: { attempts: 0 },
        db: { id: 'row-1' }
    };
}

function firstValue<K, V>(values: Map<K, V>): V {
    const first = values.values().next().value;
    if (first === undefined) {
        throw new Error('Expected a selected queue entry');
    }
    return first;
}
