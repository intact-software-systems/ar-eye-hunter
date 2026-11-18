import 'fake-indexeddb/auto';

import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import {
    AL_OUTBOUND_WORK_LEASE_MS,
    AL_OUTBOUND_WORK_PAGE_SIZE,
    computeALOutboundWorkEntry,
    readALOutboundWorkReadyAt,
    toALOutboundWorkKey,
    toALOutboundWorkType
} from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { createLimitedALWorkLeaseRecovery } from '@shared/alm/work/al-work-lease-recovery.ts';
import { createALWorkQueuePort, type ALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { IndexedDbQueueBox } from '@shared/queuebox/indexed-db-queue-box.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import { EntityStatus, toKeyAsString, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

const NAMESPACE = 'browser:held-sender';
const EVERY_GATE_OPEN = {
    dequeue: { types: new Set<string>(), readyAtMs: undefined },
    leaseSweeps: { isTimeoutOpen: true, isFinalizationOpen: true }
};
/** How long ago the later batches of held sends were reserved: their leases end this much before a full lease. */
const LATER_BATCH_AGE_MS = 5_000;

const WORK_STORES: readonly (readonly [string, () => QueueBoxResourceEntryRepository])[] = [
    ['memory', () => new InMemoryQueueBox(new Map())],
    ['IndexedDB', () =>
        new IndexedDbQueueBox({
            dbName: `outbound-reserved-${crypto.randomUUID()}`,
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

/** A send whose carrier queued it: the batch retained its claim, so the row stays reserved from `startMs`. */
function toHeldSendRow(effectId: string, startMs: number, nowMs: number): ResourceEntry {
    const entry = computeALOutboundWorkEntry({
        namespace: NAMESPACE,
        effectId,
        payload: { kind: 'ack-timeout', msgId: effectId },
        observedAtMs: startMs,
        retryAtMs: startMs,
        expireAtTimestamp: nowMs + 60_000
    });
    return {
        ...entry,
        status: EntityStatus.RESERVED,
        dequeueAudit: { attempts: 1, startTs: Temporal.Instant.fromEpochMilliseconds(startMs) }
    };
}

/**
 * More than a page of held sends, as retained claims leave them under a transport hold: the row whose key sorts last
 * was reserved first and its lease has ended; every other row was reserved later and its lease runs on.
 */
function toHeldSendRows(nowMs: number): { rows: ResourceEntry[]; leaseEnded: ResourceEntry; } {
    const effectIds = Array.from({ length: AL_OUTBOUND_WORK_PAGE_SIZE + 1 }, (_, index) => `send:held-${index}`)
        .sort((left, right) =>
            toKeyAsString(toALOutboundWorkKey(NAMESPACE, left)).localeCompare(
                toKeyAsString(toALOutboundWorkKey(NAMESPACE, right))
            )
        );
    const rows = effectIds.map((effectId, index) =>
        toHeldSendRow(
            effectId,
            index === AL_OUTBOUND_WORK_PAGE_SIZE
                ? nowMs - AL_OUTBOUND_WORK_LEASE_MS - 1_000
                : nowMs - LATER_BATCH_AGE_MS,
            nowMs
        )
    );
    return { rows, leaseEnded: rows[AL_OUTBOUND_WORK_PAGE_SIZE] };
}

describe.each(WORK_STORES)('reserved outbound work beyond one page on the %s store', (_store, createStore) => {
    it('advertises the earliest lease end of the key-ordered page, at most one lease after a hidden lease ended', async () => {
        // The recorded gap: no store orders reserved rows by lease end, so the scan reads them in key order and a
        // lease that ended behind a full page is advertised at the earliest lease end the page holds.
        const port = createWorkPort(createStore());
        const nowMs = Date.now();
        const { rows, leaseEnded } = toHeldSendRows(nowMs);
        for (const row of rows) {
            await port.retainIfAbsent(row);
        }

        const readyAtMs = await readALOutboundWorkReadyAt(port, nowMs, EVERY_GATE_OPEN);

        const leaseEndedAtMs = Number(leaseEnded.dequeueAudit.startTs?.epochMilliseconds) + AL_OUTBOUND_WORK_LEASE_MS;
        expect(leaseEndedAtMs).toBeLessThan(nowMs);
        expect(readyAtMs).toBe(nowMs - LATER_BATCH_AGE_MS + AL_OUTBOUND_WORK_LEASE_MS);
        expect(readyAtMs).toBeLessThanOrEqual(nowMs + AL_OUTBOUND_WORK_LEASE_MS);
    });
});
