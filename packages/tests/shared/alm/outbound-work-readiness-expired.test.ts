import { describe, expect, it } from 'vitest';

import {
    AL_OUTBOUND_WORK_PAGE_SIZE,
    computeALOutboundWorkEntry,
    readALOutboundWorkReadyAt,
    toALOutboundWorkType
} from '@shared/alm/outbound/al-outbound-work-entry.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { createOutboundWorkPort, EVERY_GATE_OPEN, OUTBOUND_WORK_STORES } from './outbound-work-readiness-fixture.ts';

const NAMESPACE = 'browser:lossy-sender';

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

describe.each(OUTBOUND_WORK_STORES)('outbound work behind expired rows on the %s store', (_store, createStore) => {
    it.each([
        ['a whole page', AL_OUTBOUND_WORK_PAGE_SIZE],
        ['more than a page', AL_OUTBOUND_WORK_PAGE_SIZE + 4]
    ])('advertises a send due now although %s of expired rows is due before it', async (_label, expired) => {
        const port = createOutboundWorkPort(createStore(), new Set([toALOutboundWorkType(NAMESPACE)]));
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
