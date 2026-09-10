import { toALOutboundWorkType } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import { NOT_COMPLETED_RETRYABLE_STATUSES } from '@shared/queuebox/ResourceEntry.ts';
import { expect, vi } from 'vitest';

const SETTLE_ATTEMPT_LIMIT = 200;

/**
 * Outbound admission commits and returns; the work owner sends on its own batch. This waits until
 * every row of the namespace's work types -- plus any foreign dequeue type the owner also claims --
 * has left the non-terminal statuses, so an assertion about a send observes a finished batch.
 */
export async function waitForSettledOutboundWork(
    workQueue: QueueBoxResourceEntryRepository,
    namespace: string,
    dequeueTypes: ReadonlySet<string> = new Set<string>()
): Promise<void> {
    const workTypes = new Set([toALOutboundWorkType(namespace), ...dequeueTypes]);
    for (let attempt = 0; attempt < SETTLE_ATTEMPT_LIMIT; attempt += 1) {
        if (!await hasPendingOutboundWork(workQueue, workTypes)) {
            return;
        }
        await yieldToOutboundWork();
    }
    expect(await hasPendingOutboundWork(workQueue, workTypes)).toBe(false);
}

async function hasPendingOutboundWork(
    workQueue: QueueBoxResourceEntryRepository,
    workTypes: ReadonlySet<string>
): Promise<boolean> {
    const entries = await Promise.all(
        (await workQueue.getAllKeys()).map((key) => workQueue.getItem(key))
    );
    return entries.some((entry) =>
        entry !== undefined && workTypes.has(entry.typeId) &&
        NOT_COMPLETED_RETRYABLE_STATUSES.has(entry.status)
    );
}

/** One turn past the current queue: enough for an in-memory owner to finish the batch it started. */
export async function yieldToOutboundWork(): Promise<void> {
    if (vi.isFakeTimers()) {
        await vi.advanceTimersByTimeAsync(0);
        return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
}

const MICROTASK_DRAIN_TURNS = 50;

/**
 * Settles the batch a caller-owned runtime's own commit already started, without crossing a
 * macrotask boundary. A caller-owned runtime schedules its own recheck via `setTimeout` on first
 * `ready()`; a timer-based yield (`yieldToOutboundWork`) would give that recheck a turn too, which
 * is not "wait for only the batch this call committed."
 */
export async function settleCommittedOutboundBatch(): Promise<void> {
    for (let turn = 0; turn < MICROTASK_DRAIN_TURNS; turn += 1) {
        await Promise.resolve();
    }
}
