import { Temporal } from '@js-temporal/polyfill';
import { expect, it } from 'vitest';

import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import type { ResourceInboxWorkPage } from '@shared/queuebox/queue-box-types.ts';
import { EntityStatus, toKeyAsString } from '@shared/queuebox/ResourceEntry.ts';

import { createCheckpointTestEntry } from '../alm/checkpoint/checkpoint-test-entry.ts';

it('publishes release only after every selected entry has its final value', async () => {
    const queue = new InMemoryQueueBox();
    const first = createCheckpointTestEntry('first');
    const second = createCheckpointTestEntry('second');
    await queue.enqueue(first);
    await queue.enqueue(second);
    const reserved = await queue.reserveEntries({ typeIds: new Set(['checkpoint.work']), statusIds: new Set([EntityStatus.NEW]), reservationInput: 2 });
    const views: (EntityStatus | undefined)[][] = [];
    queue.onChangeDo(() => views.push([queue.peek(toKeyAsString(first.key))?.status, queue.peek(toKeyAsString(second.key))?.status]));
    await queue.releaseEntries([...reserved.values()].map((entry) => ({ entry, disposition: { status: EntityStatus.COMPLETED, delayMs: null } })));
    expect(views).toEqual([[EntityStatus.COMPLETED, EntityStatus.COMPLETED], [EntityStatus.COMPLETED, EntityStatus.COMPLETED]]);
});

it.each(['completed', 'expired'] as const)('commits the complete %s cleanup before observers enqueue replacement work', async (selection) => {
    const now = Temporal.Instant.fromEpochMilliseconds(10_000);
    const queue = new InMemoryQueueBox(new Map(), () => now);
    const entries = ['first', 'second'].map((resourceId) => {
        const entry = createCheckpointTestEntry(resourceId);
        return selection === 'completed'
            ? { ...entry, status: EntityStatus.COMPLETED }
            : { ...entry, audit: { ...entry.audit, expiryTs: now } };
    });
    for (const entry of entries) {
        await queue.enqueue(entry);
    }
    const committedViews: (EntityStatus | undefined)[][] = [];
    const indexedViews: Promise<ResourceInboxWorkPage>[] = [];
    let replaced = false;
    queue.onChangeDo(() => {
        if (replaced) {
            return;
        }
        replaced = true;
        committedViews.push(entries.map((entry) => queue.peek(toKeyAsString(entry.key))?.status));
        indexedViews.push(queue.readWorkPage({ typeId: 'checkpoint.work', status: entries[0].status, maxToRead: 10, cursor: null }));
        for (const entry of entries) {
            void queue.enqueue({ ...createCheckpointTestEntry(entry.key.resourceId), resource: 'fresh observer-owned work' });
        }
    });

    expect(queue.cleanup()).toBe(true);
    expect(committedViews).toEqual([[undefined, undefined]]);
    expect(await Promise.all(indexedViews)).toEqual([{ entries: [], nextCursor: null }]);
    for (const entry of entries) {
        expect(queue.peek(toKeyAsString(entry.key))).toMatchObject({ status: EntityStatus.NEW, resource: 'fresh observer-owned work' });
    }
    const indexed = await queue.readWorkPage({ typeId: 'checkpoint.work', status: EntityStatus.NEW, maxToRead: 10, cursor: null });
    expect(indexed.entries.map((entry) => entry.key.resourceId)).toEqual(['first', 'second']);
    expect(indexed.entries.map((entry) => entry.resource)).toEqual(['fresh observer-owned work', 'fresh observer-owned work']);
});

it.each(['overdue', 'exhausted'] as const)('commits the complete %s reservation before observers replace selected work', async (selection) => {
    const now = Temporal.Instant.fromEpochMilliseconds(10_000);
    const due = Temporal.Instant.fromEpochMilliseconds(1);
    const queue = new InMemoryQueueBox(new Map(), () => now);
    const entries = ['first', 'second'].map((resourceId) => ({
        ...createCheckpointTestEntry(resourceId),
        status: selection === 'overdue' ? EntityStatus.RETRY : EntityStatus.RESERVED,
        dequeueAudit: { attempts: selection === 'overdue' ? 1 : 20, startTs: due, nextTs: due }
    }));
    for (const entry of entries) {
        await queue.enqueue(entry);
    }
    const committedViews: (number | undefined)[][] = [];
    const indexedViews: Promise<ResourceInboxWorkPage>[] = [];
    let replaced = false;
    queue.onChangeDo(() => {
        if (replaced) {
            return;
        }
        replaced = true;
        committedViews.push(entries.map((entry) => queue.peek(toKeyAsString(entry.key))?.dequeueAudit.attempts));
        indexedViews.push(queue.readWorkPage({ typeId: 'checkpoint.work', status: EntityStatus.RESERVED, maxToRead: 10, cursor: null }));
        for (const entry of entries) {
            void queue.enqueue({ ...createCheckpointTestEntry(entry.key.resourceId), resource: 'fresh observer-owned work' });
        }
    });

    const reserved = selection === 'overdue'
        ? await queue.reserveOverdueRetryEntries(new Set(['checkpoint.work']), 9_000, 2)
        : await queue.reserveRetryExhaustionFinalizations(new Set(['checkpoint.work']), {
            maxToReserve: 2,
            processingAttempts: 20,
            staleAfterMs: 1_000
        });
    const attempts = selection === 'overdue' ? 2 : 21;
    expect(committedViews).toEqual([[attempts, attempts]]);
    const [committedIndex] = await Promise.all(indexedViews);
    expect(committedIndex).toMatchObject({
        entries: [{ status: EntityStatus.RESERVED, dequeueAudit: { attempts } }, { status: EntityStatus.RESERVED, dequeueAudit: { attempts } }],
        nextCursor: null
    });
    expect([...reserved.values()]).toMatchObject(
        entries.map((entry) => ({
            entry: { key: entry.key, status: EntityStatus.RESERVED, resource: entry.resource, dequeueAudit: { attempts } },
            selectedDueTs: due
        }))
    );
    for (const entry of entries) {
        expect(queue.peek(toKeyAsString(entry.key))).toMatchObject({
            status: EntityStatus.NEW,
            resource: 'fresh observer-owned work',
            dequeueAudit: { attempts: 0 }
        });
    }
    const indexed = await queue.readWorkPage({ typeId: 'checkpoint.work', status: EntityStatus.NEW, maxToRead: 10, cursor: null });
    expect(indexed.entries.map((entry) => entry.key.resourceId)).toEqual(['first', 'second']);
    expect((await queue.readWorkPage({ typeId: 'checkpoint.work', status: EntityStatus.RESERVED, maxToRead: 10, cursor: null })).entries).toEqual([]);
    expect((await queue.readWorkPage({ typeId: 'checkpoint.work', status: EntityStatus.RETRY, maxToRead: 10, cursor: null })).entries).toEqual([]);
});
