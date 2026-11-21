import 'fake-indexeddb/auto';

import {
    AL_OUTBOUND_WORK_LEASE_MS,
    AL_OUTBOUND_WORK_PAGE_SIZE,
    computeALOutboundWorkEntry,
    readALOutboundWorkReadyAt,
    toALOutboundWorkType
} from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { createLimitedALWorkLeaseRecovery } from '@shared/alm/work/al-work-lease-recovery.ts';
import { createALWorkQueuePort, type ALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
import { InMemoryQueueBox, type ResourceEntry } from '@shared/mod.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { IndexedDbQueueBox } from '@shared/queuebox/indexed-db-queue-box.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import { describe, expect, it } from 'vitest';

const NAMESPACE = 'browser:sender';
const ACK_TIMEOUT_MS = 2_000;
const EVERY_GATE_OPEN = {
    dequeue: { types: new Set<string>(), readyAtMs: undefined },
    leaseSweeps: { isTimeoutOpen: true, isFinalizationOpen: true }
};

/** The two stores a work queue runs on: a page's memory, and the IndexedDB store a browser page uses. */
const WORK_STORES: readonly (readonly [string, () => QueueBoxResourceEntryRepository])[] = [
    ['memory', () => new InMemoryQueueBox(new Map())],
    ['IndexedDB', () =>
        new IndexedDbQueueBox({
            dbName: `outbound-work-${crypto.randomUUID()}`,
            storeName: IndexedDbQueueBox.DEFAULT_STORE_NAME,
            observer: createPassThroughIndexedDbOperationObserver()
        })]
];

/** One work row of the sender's outbound owner, as a commit writes it: due at `retryAtMs`. */
function toWorkRow(effectId: string, retryAtMs: number, nowMs: number): ResourceEntry {
    return computeALOutboundWorkEntry({
        namespace: NAMESPACE,
        effectId,
        payload: { kind: 'ack-timeout', msgId: effectId },
        observedAtMs: nowMs,
        retryAtMs,
        expireAtTimestamp: nowMs + 60_000
    });
}

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

/** A sender with `timers` receipts pending, each timer due later, and one send that is due now. */
async function retainTimersAndOneDueSend(port: ALWorkQueuePort, timers: number): Promise<ResourceEntry> {
    const nowMs = Date.now();
    for (let timer = 0; timer < timers; timer += 1) {
        await port.retainIfAbsent(toWorkRow(`ack-timeout:message-${timer}:1`, nowMs + ACK_TIMEOUT_MS, nowMs));
    }
    return await port.retainIfAbsent(toWorkRow('send:message-due-now:prepared', nowMs, nowMs));
}

describe.each(WORK_STORES)('outbound work behind pending receipts on the %s store', (_store, createStore) => {
    it.each([
        ['one fewer than a page', AL_OUTBOUND_WORK_PAGE_SIZE - 1],
        ['a whole page', AL_OUTBOUND_WORK_PAGE_SIZE],
        ['more than a page', AL_OUTBOUND_WORK_PAGE_SIZE + 4]
    ])('advertises work that is due now although %s of ACK timers is due later', async (_label, timers) => {
        const port = createWorkPort(createStore());
        await retainTimersAndOneDueSend(port, timers);

        const readyAtMs = await readALOutboundWorkReadyAt(port, Date.now(), EVERY_GATE_OPEN);

        expect(readyAtMs).toBeLessThanOrEqual(Date.now());
    });

    it.each([
        ['one fewer than a page', AL_OUTBOUND_WORK_PAGE_SIZE - 1],
        ['a whole page', AL_OUTBOUND_WORK_PAGE_SIZE],
        ['more than a page', AL_OUTBOUND_WORK_PAGE_SIZE + 4]
    ])('claims the work that is due now although %s of ACK timers is due later', async (_label, timers) => {
        const port = createWorkPort(createStore());
        const due = await retainTimersAndOneDueSend(port, timers);

        const claims = await port.claim({ maxCount: AL_OUTBOUND_WORK_PAGE_SIZE, observedEntries: undefined });

        expect(claims.map((claim) => claim.entry.key)).toEqual([due.key]);
    });
});
