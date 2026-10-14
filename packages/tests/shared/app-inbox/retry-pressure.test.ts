import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, vi } from 'vitest';

import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import type { ResourceInboxWorkPage } from '@shared/queuebox/queue-box-types.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { createQueueResilience, seedRetry } from './fair-service-fixture.ts';

class ObservedQueue extends InMemoryQueueBox {
    readonly requests: ResourceInboxWorkPage.Request[] = [];
    pendingRead: Promise<void> | undefined;
    failReads = false;
    malformedReads = false;

    override async readWorkPage(request: ResourceInboxWorkPage.Request): Promise<ResourceInboxWorkPage> {
        this.requests.push(request);
        const page = await super.readWorkPage(request);
        await this.pendingRead;
        if (this.failReads) {
            throw new Error('Observation unavailable');
        }
        if (this.malformedReads) {
            return JSON.parse('{"entries":null,"nextCursor":null}');
        }
        return page;
    }
}

interface RetryBacklog {
    readonly queue: ObservedQueue;
    readonly reader: InboxQueueReader;
    readonly delivered: string[];
    readonly advance: (milliseconds: number) => void;
}

async function createRetryBacklog(count = 6, becomeDue = true): Promise<RetryBacklog> {
    let now = Date.now();
    const queue = new ObservedQueue(new Map(), () => Temporal.Instant.fromEpochMilliseconds(now));
    const reader = new InboxQueueReader(queue, { nowEpochMs: () => now });
    const delivered: string[] = [];
    reader.onInboxMessageDo('test.fair-service', {
        onMessage: async (message) => {
            delivered.push(message.route.resourceId);
        }
    });
    for (let index = 0; index < count; index += 1) {
        await seedRetry(queue, `retry-${index}`);
    }
    if (becomeDue) {
        now += 2;
    }
    return {
        queue,
        reader,
        delivered,
        advance: (milliseconds: number) => {
            now += milliseconds;
        }
    };
}

describe('AppInbox retry pressure observation', () => {
    it('continues retry service when work becomes due after a cached zero observation', async () => {
        const { queue, reader, delivered, advance } = await createRetryBacklog(2, false);
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createQueueResilience());
        expect(delivered).toEqual([]);
        advance(2);
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createQueueResilience());
        expect(delivered).toEqual(['retry-0']);
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createQueueResilience());
        expect(delivered).toEqual(['retry-0', 'retry-1']);
        expect(queue.requests).toHaveLength(1);
    });

    it('rotates past future work without treating an incomplete page as an empty lane', async () => {
        const { queue, reader, delivered, advance } = await createRetryBacklog(8);
        const page = await queue.readWorkPage({
            typeId: InboxQueueReader.INBOX_ENQUEUE_TYPE,
            status: EntityStatus.RETRY,
            maxToRead: 2,
            cursor: null
        });
        for (const entry of page.entries) {
            await queue.enqueue({
                ...entry,
                dequeueAudit: {
                    ...entry.dequeueAudit,
                    nextTs: entry.dequeueAudit.nextTs!.add({ seconds: 20 })
                }
            });
        }
        queue.requests.length = 0;
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createQueueResilience());
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createQueueResilience());
        expect(delivered).toEqual(['retry-2', 'retry-3']);
        advance(2_000);
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createQueueResilience());
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createQueueResilience());
        expect(delivered).toEqual(['retry-2', 'retry-3', 'retry-4', 'retry-5', 'retry-6']);
        expect(queue.requests).toHaveLength(2);
        expect(queue.requests[1]?.cursor).not.toBeNull();
    });

    it('discards an in-flight positive sample after the processing ceiling changes and changes back', async () => {
        const { queue, reader, delivered } = await createRetryBacklog();
        let releaseRead!: () => void;
        queue.pendingRead = new Promise<void>((resolve) => {
            releaseRead = resolve;
        });
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createQueueResilience());
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createQueueResilience(3));
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createQueueResilience());
        releaseRead();
        await queue.pendingRead;
        await Promise.resolve();
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createQueueResilience());
        expect(delivered).toHaveLength(4);
        expect(queue.requests).toHaveLength(1);
    });

    it('uses cold fallback then catches up from a real bounded page across stable-policy callers', async () => {
        const { queue, reader, delivered } = await createRetryBacklog();

        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createQueueResilience());
        expect(delivered).toHaveLength(1);
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createQueueResilience());

        expect(delivered).toHaveLength(3);
        expect(queue.requests).toHaveLength(1);
        expect(queue.requests[0]).toMatchObject({ maxToRead: 2, cursor: null, status: 'RETRY' });
    });

    it.each(['expired', 'exhausted', 'missing-due'])('does not promote a page of %s retry rows', async (kind) => {
        const { queue, reader, delivered } = await createRetryBacklog();
        const page = await queue.readWorkPage({
            typeId: InboxQueueReader.INBOX_ENQUEUE_TYPE,
            status: EntityStatus.RETRY,
            maxToRead: 2,
            cursor: null
        });
        for (const entry of page.entries) {
            await queue.enqueue({
                ...entry,
                audit: { ...entry.audit, expiryTs: kind === 'expired' ? Temporal.Instant.fromEpochMilliseconds(0) : entry.audit.expiryTs },
                dequeueAudit: {
                    ...entry.dequeueAudit,
                    attempts: kind === 'exhausted' ? 3 : entry.dequeueAudit.attempts,
                    nextTs: kind === 'missing-due' ? undefined : entry.dequeueAudit.nextTs
                }
            });
        }
        queue.requests.length = 0;
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createQueueResilience(3));
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createQueueResilience(3));
        expect(delivered).toHaveLength(2);
        expect(queue.requests).toHaveLength(1);
    });

    it('refreshes after pressure disappears and continues serving work that returns behind a zero sample', async () => {
        const { queue, reader, delivered, advance } = await createRetryBacklog(3);
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createQueueResilience());
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createQueueResilience());
        expect(delivered).toHaveLength(3);
        advance(2_000);
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createQueueResilience());
        await seedRetry(queue, 'returned-0');
        await seedRetry(queue, 'returned-1');
        advance(2);
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createQueueResilience());
        expect(delivered).toHaveLength(4);
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createQueueResilience());
        expect(delivered).toHaveLength(5);
        expect(queue.requests).toHaveLength(2);
    });

    it('returns fallback during a stalled refresh and admits only one concurrent observation', async () => {
        const { queue, reader, delivered, advance } = await createRetryBacklog();
        let releaseRead!: () => void;
        queue.pendingRead = new Promise<void>((resolve) => {
            releaseRead = resolve;
        });

        await Promise.all(Array.from({ length: 2 }, () => reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createQueueResilience())));
        advance(2_000);
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createQueueResilience());

        expect(delivered).toHaveLength(3);
        expect(queue.requests).toHaveLength(1);
        releaseRead();
    });

    it('expires positive pressure without blocking service on the next stalled page', async () => {
        const { queue, reader, delivered, advance } = await createRetryBacklog();
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createQueueResilience());
        advance(2_000);
        let releaseRead!: () => void;
        queue.pendingRead = new Promise<void>((resolve) => {
            releaseRead = resolve;
        });

        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createQueueResilience());

        expect(delivered).toHaveLength(2);
        expect(queue.requests).toHaveLength(2);
        expect(queue.requests[1]?.cursor).not.toBeNull();
        releaseRead();
    });

    it.each(['failure', 'malformed'])('reports %s observations while keeping positive fallback service', async (kind) => {
        const { queue, reader, delivered } = await createRetryBacklog();
        queue.failReads = kind === 'failure';
        queue.malformedReads = kind === 'malformed';
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createQueueResilience());
            await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createQueueResilience());
            expect(delivered).toHaveLength(2);
            expect(queue.requests).toHaveLength(1);
            expect(warning).toHaveBeenCalledWith('AppInbox retry pressure observation failed', expect.any(Error));
        }
        finally {
            warning.mockRestore();
        }
    });
});
