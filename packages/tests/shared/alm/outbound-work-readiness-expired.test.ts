import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import {
    AL_OUTBOUND_WORK_LEASE_MS,
    AL_OUTBOUND_WORK_PAGE_SIZE,
    computeALOutboundWorkEntry,
    readALOutboundWorkReadyAt,
    toALOutboundWorkType
} from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { createLimitedALWorkLeaseRecovery } from '@shared/alm/work/al-work-lease-recovery.ts';
import { createALWorkQueuePort, type ALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { IndexedDbQueueBox } from '@shared/queuebox/indexed-db-queue-box.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

const NAMESPACE = 'browser:lossy-sender';
const EVERY_GATE_OPEN = {
    dequeue: { types: new Set<string>(), readyAtMs: undefined },
    leaseSweeps: { isTimeoutOpen: true, isFinalizationOpen: true }
};

const WORK_STORES: readonly (readonly [string, () => QueueBoxResourceEntryRepository])[] = [
    ['memory', () => new InMemoryQueueBox(new Map())],
    ['IndexedDB', () =>
        new IndexedDbQueueBox({
            dbName: `outbound-expired-${crypto.randomUUID()}`,
            storeName: IndexedDbQueueBox.DEFAULT_STORE_NAME,
            observer: createPassThroughIndexedDbOperationObserver()
        })]
];

function createWorkPort(queue: QueueBoxResourceEntryRepository): ALWorkQueuePort {
    return createALWorkQueuePort({
        queue,
        workTypes: new Set([toALOutboundWorkType(NAMESPACE)]),
        leaseMs: AL_OUTBOUND_WORK_LEASE_MS,
        nowMs: Date.now,
        random: Math.random,
        leaseRecovery: createLimitedALWorkLeaseRecovery(AL_OUTBOUND_WORK_LEASE_MS, Date.now())
    });
}

/** A held send whose deadline passed before the queue's expiry eviction ran: it is due earliest of all. */
function toExpiredSendRow(effectId: string, retryAtMs: number, nowMs: number): ResourceEntry {
    return computeALOutboundWorkEntry({
        namespace: NAMESPACE,
        effectId,
        payload: { kind: 'ack-timeout', msgId: effectId },
        observedAtMs: retryAtMs,
        retryAtMs,
        expireAtTimestamp: nowMs - 1_000
    });
}

describe.each(WORK_STORES)('outbound work behind expired rows on the %s store', (_store, createStore) => {
    it.each([
        ['a whole page', AL_OUTBOUND_WORK_PAGE_SIZE],
        ['more than a page', AL_OUTBOUND_WORK_PAGE_SIZE + 4]
    ])('advertises a send due now although %s of expired rows is due before it', async (_label, expired) => {
        const port = createWorkPort(createStore());
        const nowMs = Date.now();
        for (let row = 0; row < expired; row += 1) {
            await port.retainIfAbsent(toExpiredSendRow(`send:expired-${row}:prepared`, nowMs - 60_000 + row, nowMs));
        }
        await port.retainIfAbsent(computeALOutboundWorkEntry({
            namespace: NAMESPACE,
            effectId: 'send:message-due-now:prepared',
            payload: { kind: 'ack-timeout', msgId: 'send:message-due-now:prepared' },
            observedAtMs: nowMs,
            retryAtMs: nowMs,
            expireAtTimestamp: nowMs + 60_000
        }));

        const readyAtMs = await readALOutboundWorkReadyAt(port, Date.now(), EVERY_GATE_OPEN);

        expect(readyAtMs).toBeLessThanOrEqual(Date.now());
    });
});
