import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import {
    EntityStatus,
    NEVER_EXPIRE_TS,
    toKeyAsString,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';

const NOW = Temporal.Instant.from('2026-10-02T12:00:00Z');

describe('InMemoryQueueBox change notification', () => {
    it('names the key of every write, reservation and release, in the turn it happens', async () => {
        const queue = new InMemoryQueueBox(undefined, () => NOW);
        const changed: string[] = [];
        queue.onChangeDo((key) => changed.push(key));
        const entry = createEntry('first');

        await queue.enqueue(entry);
        queue.writeIfAllObserved([{ expected: undefined, entry: createEntry('second') }]);
        const reserved = await queue.reserveEntries({
            typeIds: new Set([entry.typeId]),
            statusIds: new Set([EntityStatus.NEW]),
            reservationInput: 1
        });
        await queue.releaseEntries([...reserved.values()].map((current) => ({
            entry: current,
            disposition: { status: EntityStatus.COMPLETED, delayMs: null }
        })));

        expect(changed).toEqual([toKey('first'), toKey('second'), toKey('first'), toKey('first')]);
    });

    it('names the keys an expiry or a cleanup removes, and nothing for a conflicting write', async () => {
        const expired = createEntry('expired', NOW.subtract({ seconds: 1 }));
        const completed = { ...createEntry('completed'), status: EntityStatus.COMPLETED };
        const queue = new InMemoryQueueBox(new Map([[expired.key, expired], [completed.key, completed]]), () => NOW);
        const changed: string[] = [];
        queue.onChangeDo((key) => changed.push(key));

        expect(queue.writeIfAllObserved([{ expected: undefined, entry: completed }])).toBe(false);
        queue.cleanup();

        expect(changed.toSorted()).toEqual([toKey('completed'), toKey('expired')]);
    });

    it('stops naming keys once unsubscribed', async () => {
        const queue = new InMemoryQueueBox(undefined, () => NOW);
        const changed: string[] = [];
        const subscription = queue.onChangeDo((key) => changed.push(key));

        subscription.unsubscribe();
        await queue.enqueue(createEntry('after'));

        expect(changed).toEqual([]);
    });

    it('peeks an entry as held, an expired one included, without removing it', async () => {
        const expired = createEntry('expired', NOW.subtract({ seconds: 1 }));
        const queue = new InMemoryQueueBox(new Map([[expired.key, expired]]), () => NOW);
        const changed: string[] = [];
        queue.onChangeDo((key) => changed.push(key));

        expect(queue.peek(toKey('expired'))).toMatchObject({ key: expired.key, resource: expired.resource });
        expect(queue.peek(toKey('expired'))).not.toBe(queue.peek(toKey('expired')));
        expect(queue.peek(toKey('absent'))).toBeUndefined();
        expect(changed).toEqual([]);
    });
});

function toKey(resourceId: string): string {
    return toKeyAsString({ topicId: 'checkpoint.work', resourceId, contextId: 'ctx' });
}

function createEntry(resourceId: string, expiryTs: Temporal.Instant = NEVER_EXPIRE_TS): ResourceEntry {
    return {
        key: { topicId: 'checkpoint.work', resourceId, contextId: 'ctx' },
        resource: JSON.stringify({ resourceId }),
        typeId: 'checkpoint.work',
        audit: {
            date: Temporal.PlainTime.from('12:00:00'),
            createdBy: 'test',
            createdTs: Temporal.PlainDateTime.from('2026-10-02T12:00:00'),
            expiryTs
        },
        status: EntityStatus.NEW,
        dequeueAudit: { attempts: 0 },
        db: undefined
    };
}
