// @vitest-environment happy-dom

import '../setup-browser-indexeddb.ts';

import { Temporal } from '@js-temporal/polyfill';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { IndexedDbQueueBox } from '@shared/queuebox/indexed-db-queue-box.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

afterEach(() => vi.useRealTimers());

describe.each(['memory', 'indexeddb'])('QueueBox readiness accounting: %s', (backend) => {
    it.each([30_000, 30_001])('rejects readiness release at elapsed %s without changing the reserved row', async (elapsedMs) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const startedAt = Date.parse('2026-01-01T00:00:00Z');
        vi.setSystemTime(startedAt);
        const queue = backend === 'memory' ? new InMemoryQueueBox() : new IndexedDbQueueBox({ dbName: `expired-release-${crypto.randomUUID()}` });
        const original = createEntry();
        await queue.enqueue(original);
        const reserved =
            [...(await queue.reserveEntries({ typeIds: new Set(['waiting']), statusIds: new Set([EntityStatus.NEW]), reservationInput: 1 })).values()][0];
        vi.setSystemTime(startedAt + elapsedMs);
        await expect(queue.releaseEntries([reserved], { status: EntityStatus.RETRY, delayMs: 60_000, reason: 'not-ready' }))
            .rejects.toMatchObject({ code: 'resource-inbox-lost-reservation' });
        vi.setSystemTime(startedAt);
        expect(await queue.getItem(original.key)).toEqual(reserved);
    });

    it('bounds readiness scheduling by the original deadline and never claims at exact expiry', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const queue = backend === 'memory' ? new InMemoryQueueBox() : new IndexedDbQueueBox({ dbName: `deadline-${crypto.randomUUID()}` });
        const original = createEntry();
        await queue.enqueue(original);
        const reserved =
            [...(await queue.reserveEntries({ typeIds: new Set(['waiting']), statusIds: new Set([EntityStatus.NEW]), reservationInput: 1 })).values()][0];
        const released = [...(await queue.releaseEntries([reserved], { status: EntityStatus.RETRY, delayMs: 60_000, reason: 'not-ready' })).values()][0];
        expect(released.dequeueAudit.nextTs?.epochMilliseconds).toBe(Date.now() + 30_000);
        expect(released.audit).toEqual(original.audit);
        vi.setSystemTime(Date.now() + 30_000);
        expect(await queue.reserveEntries({ typeIds: new Set(['waiting']), statusIds: new Set([EntityStatus.RETRY]), reservationInput: 1 })).toEqual(new Map());
    });
    it('refunds only the readiness reservation after a real failed attempt', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const queue = backend === 'memory' ? new InMemoryQueueBox() : new IndexedDbQueueBox({ dbName: `failure-${crypto.randomUUID()}` });
        await queue.enqueue(createEntry());
        const request = { typeIds: new Set(['waiting']), statusIds: new Set([EntityStatus.NEW, EntityStatus.RETRY]), reservationInput: 1 };
        const failed = [...(await queue.reserveEntries(request)).values()][0];
        await queue.releaseEntries([failed], { status: EntityStatus.RETRY, delayMs: 1 });
        vi.setSystemTime(Date.now() + 1);
        for (let cycle = 0; cycle < 25; cycle += 1) {
            const reserved = [...(await queue.reserveEntries(request)).values()][0];
            expect(reserved.dequeueAudit.attempts).toBe(2);
            const released = [...(await queue.releaseEntries([reserved], { status: EntityStatus.RETRY, delayMs: 1, reason: 'not-ready' })).values()][0];
            expect(released.dequeueAudit.attempts).toBe(1);
            vi.setSystemTime(Date.now() + 1);
        }
        const reserved = [...(await queue.reserveEntries(request)).values()][0];
        const completed = [...(await queue.releaseEntries([reserved], { status: EntityStatus.COMPLETED, delayMs: null })).values()][0];
        expect(completed.dequeueAudit.attempts).toBe(2);
    });

    it('defers repeatedly without consuming the processing budget or changing the reservation and message', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const queue = backend === 'memory'
            ? new InMemoryQueueBox()
            : new IndexedDbQueueBox({ dbName: `readiness-${crypto.randomUUID()}` });
        const original = createEntry();
        await queue.enqueue(original);

        for (let cycle = 0; cycle < 25; cycle += 1) {
            const reserved = [...(await queue.reserveEntries({
                typeIds: new Set(['waiting']),
                statusIds: new Set([EntityStatus.NEW, EntityStatus.RETRY]),
                reservationInput: 1
            })).values()][0];
            expect(reserved).toBeDefined();
            const snapshot = JSON.stringify(reserved);
            const released = [...(await queue.releaseEntries([reserved], {
                status: EntityStatus.RETRY,
                delayMs: 50,
                reason: 'not-ready'
            })).values()][0];
            expect(released.dequeueAudit.attempts).toBe(0);
            expect(released.status).toBe(EntityStatus.RETRY);
            expect(released.dequeueAudit.nextTs?.epochMilliseconds).toBe(Date.now() + 50);
            expect(released.audit).toEqual(original.audit);
            expect(released.resource).toBe(original.resource);
            expect(JSON.stringify(reserved)).toBe(snapshot);
            expect((await queue.reserveEntries({ typeIds: new Set(['waiting']), statusIds: new Set([EntityStatus.RETRY]), reservationInput: 1 })).size).toBe(0);
            vi.setSystemTime(Date.now() + 50);
        }

        const reserved =
            [...(await queue.reserveEntries({ typeIds: new Set(['waiting']), statusIds: new Set([EntityStatus.RETRY]), reservationInput: 1 })).values()][0];
        const completed = [...(await queue.releaseEntries([reserved], { status: EntityStatus.COMPLETED, delayMs: null })).values()][0];
        expect(completed.status).toBe(EntityStatus.COMPLETED);
        expect(completed.dequeueAudit.attempts).toBe(1);
    });
});

function createEntry(): ResourceEntry {
    return {
        key: { topicId: 'waiting', resourceId: 'message', contextId: 'scope' },
        typeId: 'waiting',
        resource: '{"message":"original"}',
        status: EntityStatus.NEW,
        audit: {
            date: Temporal.PlainTime.from('00:00:00'),
            createdTs: Temporal.PlainDateTime.from('2026-01-01T00:00:00'),
            createdBy: 'test',
            expiryTs: Temporal.Instant.from('2026-01-01T00:00:30Z')
        },
        dequeueAudit: { attempts: 0 },
        db: undefined
    };
}
