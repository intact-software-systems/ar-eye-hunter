import { expect, vi } from 'vitest';

import { resolveALInboundWorkDueAtMs } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import { EntityStatus, NOT_COMPLETED_RETRYABLE_STATUSES } from '@shared/queuebox/ResourceEntry.ts';

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

/** Wait until no retained row is claimed or due now: a row due later, such as a gap's renewal timer, may remain. */
export async function waitForALInboundWorkDueNowSettled(workQueue: QueueBoxResourceEntryRepository): Promise<void> {
    await expect.poll(async () => {
        const dueAtMs = await readInboundTestWorkDueAtMs(workQueue);
        return dueAtMs === undefined || dueAtMs > Date.now();
    }).toBe(true);
}

/** When the earliest unexpired row still to run comes due; a claimed row is due now, and nothing pending is none. */
export async function readInboundTestWorkDueAtMs(workQueue: QueueBoxResourceEntryRepository): Promise<number | undefined> {
    const nowMs = Date.now();
    let dueAtMs: number | undefined;
    for (const key of await workQueue.getAllKeys()) {
        const row = await workQueue.getItem(key);
        if (
            row === undefined || row === null || !NOT_COMPLETED_RETRYABLE_STATUSES.has(row.status) ||
            row.audit.expiryTs.epochMilliseconds <= nowMs
        ) {
            continue;
        }
        const rowDueAtMs = row.status === EntityStatus.RESERVED ? nowMs : resolveALInboundWorkDueAtMs(row);
        dueAtMs = Math.min(dueAtMs ?? rowDueAtMs, rowDueAtMs);
    }
    return dueAtMs;
}
