import 'fake-indexeddb/auto';

import { AL_OUTBOUND_WORK_LEASE_MS, type ALOutboundWorkDeferral } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { createLimitedALWorkLeaseRecovery } from '@shared/alm/work/al-work-lease-recovery.ts';
import { createALWorkQueuePort, type ALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { IndexedDbQueueBox } from '@shared/queuebox/indexed-db-queue-box.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';

/**
 * What the outbound readiness tests share. The starvation reproduction keeps its own copies: it is the slice's
 * reproduction and stays as it was written.
 */
export const EVERY_GATE_OPEN: ALOutboundWorkDeferral = {
    dequeue: { types: new Set<string>(), readyAtMs: undefined },
    leaseSweeps: { isTimeoutOpen: true, isFinalizationOpen: true }
};

/** The two stores a work queue runs on: a page's memory, and the IndexedDB store a browser page uses. */
export const OUTBOUND_WORK_STORES: readonly (readonly [string, () => QueueBoxResourceEntryRepository])[] = [
    ['memory', () => new InMemoryQueueBox(new Map())],
    ['IndexedDB', () =>
        new IndexedDbQueueBox({
            dbName: `outbound-work-${crypto.randomUUID()}`,
            storeName: IndexedDbQueueBox.DEFAULT_STORE_NAME,
            observer: createPassThroughIndexedDbOperationObserver()
        })]
];

export function createOutboundWorkPort(
    queue: QueueBoxResourceEntryRepository,
    workTypes: ReadonlySet<string>
): ALWorkQueuePort {
    return createALWorkQueuePort({
        queue,
        workTypes,
        leaseMs: AL_OUTBOUND_WORK_LEASE_MS,
        nowMs: Date.now,
        random: Math.random,
        leaseRecovery: createLimitedALWorkLeaseRecovery(AL_OUTBOUND_WORK_LEASE_MS, Date.now())
    });
}
