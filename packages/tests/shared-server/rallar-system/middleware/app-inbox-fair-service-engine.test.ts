import { Temporal } from '@js-temporal/polyfill';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerApplicationQueueReaderTasks } from '@shared-server/rallar-system/middleware/rallar-middleware-queue-registration.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import type { ResourceInboxReservationRequest } from '@shared/queuebox/queue-box-types.ts';
import { NotReadyException } from '@shared/queuebox/resource-inbox/not-ready-exception.ts';
import { EntityStatus, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import { createQueueMessage, createQueueResilience } from '../../../shared/app-inbox/fair-service-fixture.ts';

afterEach(() => vi.useRealTimers());

class ObservedEngineQueue extends InMemoryQueueBox {
    reservationCalls = 0;

    override async reserveEntries(request: ResourceInboxReservationRequest): Promise<Map<Key, ResourceEntry>> {
        this.reservationCalls += 1;
        return await super.reserveEntries(request);
    }
}

describe('registered AppInbox fair service engine', () => {
    it('re-enters for every leftover NEW command and sleeps while a neutral retry is delayed', async () => {
        vi.useFakeTimers();
        const queue = new ObservedEngineQueue(new Map(), () => Temporal.Instant.fromEpochMilliseconds(Date.now()));
        const reader = new InboxQueueReader(queue, { nowEpochMs: Date.now });
        const engine = new InboxOutboxEngine();
        const resilience = createQueueResilience();
        registerApplicationQueueReaderTasks({
            engine,
            inboxQueueReader: reader,
            outboxQueueReader: new OutboxQueueReader(queue),
            appInboxResilience: resilience,
            appOutboxResilience: createQueueResilience()
        });
        const entries = await Promise.all(['delayed', 'a', 'b', 'c'].map((id) => reader.enqueueIfAbsent(createQueueMessage(id))));
        const delivered: string[] = [];
        let delayedAttempts = 0;
        reader.onInboxMessageDo('test.fair-service', {
            onMessage: async (message) => {
                if (message.route.resourceId === 'delayed' && delayedAttempts++ === 0) {
                    throw new NotReadyException(5_000);
                }
                delivered.push(message.route.resourceId);
            }
        });
        engine.start();
        try {
            await vi.advanceTimersByTimeAsync(1_000);
            expect(delivered).toEqual(['a', 'b', 'c']);
            expect(await queue.getItem(entries[0]!.key)).toMatchObject({
                status: EntityStatus.RETRY,
                dequeueAudit: { attempts: 0 }
            });
            const reservationsBeforeDue = queue.reservationCalls;
            await vi.advanceTimersByTimeAsync(3_999);
            expect(delayedAttempts).toBe(1);
            expect(queue.reservationCalls).toBe(reservationsBeforeDue);
            expect(delivered).toHaveLength(3);
            await vi.advanceTimersByTimeAsync(5_000);
            expect(delivered).toEqual(['a', 'b', 'c', 'delayed']);
            expect(await queue.getItem(entries[0]!.key)).toMatchObject({
                status: EntityStatus.COMPLETED,
                dequeueAudit: { attempts: 1 }
            });
        }
        finally {
            engine.stop();
        }
    });
});
