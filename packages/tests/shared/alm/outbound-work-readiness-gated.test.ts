import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import {
    AL_OUTBOUND_WORK_PAGE_SIZE,
    computeALOutboundWorkEntry,
    readALOutboundWorkReadyAt,
    toALOutboundWorkType
} from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { EntityStatus, NEVER_EXPIRE_TS, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { createOutboundWorkPort, OUTBOUND_WORK_STORES } from './outbound-work-readiness-fixture.ts';

const NAMESPACE = 'server:gated-sender';
const DEQUEUE_TYPE = 'WS_OUTBOX';
const CIRCUIT_OPEN_BACKOFF_MS = 10_000;

/** A foreign row the outbound owner dequeues, waiting since `createdAtMs`: pending, so due at its creation. */
function toDequeueRow(resourceId: string, createdAtMs: number): ResourceEntry {
    const created = Temporal.Instant.fromEpochMilliseconds(createdAtMs).toZonedDateTimeISO('UTC');
    return {
        key: { topicId: 'room', resourceId, contextId: 'context' },
        resource: resourceId,
        typeId: DEQUEUE_TYPE,
        audit: {
            date: created.toPlainTime(),
            createdBy: 'server',
            createdTs: created.toPlainDateTime(),
            expiryTs: NEVER_EXPIRE_TS
        },
        status: EntityStatus.NEW,
        dequeueAudit: { attempts: 0 },
        db: undefined
    };
}

describe.each(OUTBOUND_WORK_STORES)('outbound work behind gated dequeue rows on the %s store', (_store, createStore) => {
    it.each([
        ['one fewer than a page', AL_OUTBOUND_WORK_PAGE_SIZE - 1],
        ['a whole page', AL_OUTBOUND_WORK_PAGE_SIZE],
        ['more than a page', AL_OUTBOUND_WORK_PAGE_SIZE + 4]
    ])('advertises its own work due now although %s of older dequeue rows waits on an open circuit', async (
        _label,
        gated
    ) => {
        const queue = createStore();
        const port = createOutboundWorkPort(queue, new Set([toALOutboundWorkType(NAMESPACE), DEQUEUE_TYPE]));
        const nowMs = Date.now();
        for (let row = 0; row < gated; row += 1) {
            await queue.enqueue(toDequeueRow(`dequeue-${String(row).padStart(2, '0')}`, nowMs - 5_000 + row));
        }
        await port.retainIfAbsent(computeALOutboundWorkEntry({
            namespace: NAMESPACE,
            effectId: 'ack-timeout:message:1',
            payload: { kind: 'ack-timeout', msgId: 'message' },
            observedAtMs: nowMs - 2_000,
            retryAtMs: nowMs,
            expireAtTimestamp: nowMs + 60_000
        }));

        const readyAtMs = await readALOutboundWorkReadyAt(port, nowMs, {
            dequeue: { types: new Set([DEQUEUE_TYPE]), readyAtMs: nowMs + CIRCUIT_OPEN_BACKOFF_MS },
            leaseSweeps: { isTimeoutOpen: true, isFinalizationOpen: true }
        });

        expect(readyAtMs).toBe(nowMs);
    });
});
