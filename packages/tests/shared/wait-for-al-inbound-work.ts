import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import { NOT_COMPLETED_RETRYABLE_STATUSES } from '@shared/queuebox/ResourceEntry.ts';
import { expect, vi } from 'vitest';

/**
 * Inbound admission commits and returns; the work handler delivers on its own batch. Yielding once
 * past the microtask queue settles that batch for an in-memory store, under real or faked timers.
 */
export async function waitForALInboundWork(): Promise<void> {
    if (vi.isFakeTimers()) {
        await vi.advanceTimersByTimeAsync(0);
        return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Delivery no longer runs inside admission: wait until every retained row reaches a terminal status. */
export async function waitForSettledALInboundWork(
    workQueue: QueueBoxResourceEntryRepository
): Promise<void> {
    await expect.poll(async () => {
        const entries = await Promise.all(
            (await workQueue.getAllKeys()).map((key) => workQueue.getItem(key))
        );
        return entries.every((entry) => entry === undefined || !NOT_COMPLETED_RETRYABLE_STATUSES.has(entry.status));
    }).toBe(true);
}
