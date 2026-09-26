import { expect } from 'vitest';

import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

/**
 * Waits for the fixture's due workload to finish its first attempt. RETRY is a settled attempt,
 * which lets a test inspect a failed handoff without advancing its retry clock. Future NEW work
 * (such as an ACK timeout) belongs to a later workload. No worker is invoked or woken here.
 */
export async function waitForOwnedQueueWork(queue: QueueBoxResourceEntryRepository): Promise<void> {
    await expect.poll(async () => {
        const entries = await Promise.all((await queue.getAllKeys()).map((key) => queue.getItem(key)));
        const nowMs = Date.now();
        return entries.filter((entry) =>
            entry !== undefined && (
                entry.status === EntityStatus.RESERVED ||
                (entry.status === EntityStatus.NEW &&
                    Number(entry.dequeueAudit.nextTs?.epochMilliseconds ?? 0) <= nowMs &&
                    entry.audit.expiryTs.epochMilliseconds > nowMs)
            )
        );
    }).toEqual([]);
}
