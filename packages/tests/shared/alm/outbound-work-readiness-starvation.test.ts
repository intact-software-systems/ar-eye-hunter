import {
    AL_OUTBOUND_WORK_PAGE_SIZE,
    computeALOutboundWorkEntry
} from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { InMemoryQueueBox, type ResourceEntry } from '@shared/mod.ts';
import { describe, expect, it } from 'vitest';

import { createOutboundWorkPort, peekOutboundWorkReadyAt } from './outbound-runtime-test-fixture.ts';

const NAMESPACE = 'browser:sender';
const ACK_TIMEOUT_MS = 2_000;

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

describe('outbound work readiness behind pending receipts', () => {
    it.each([
        ['one fewer than a page', AL_OUTBOUND_WORK_PAGE_SIZE - 1],
        ['a whole page', AL_OUTBOUND_WORK_PAGE_SIZE],
        ['more than a page', AL_OUTBOUND_WORK_PAGE_SIZE + 4]
    ])('advertises work that is due now although %s of ACK timers is due later', async (_label, timers) => {
        const nowMs = Date.now();
        const workQueue = new InMemoryQueueBox(new Map());
        const port = createOutboundWorkPort(workQueue, NAMESPACE);
        for (let timer = 0; timer < timers; timer += 1) {
            await port.retainIfAbsent(toWorkRow(`ack-timeout:message-${timer}:1`, nowMs + ACK_TIMEOUT_MS, nowMs));
        }
        await port.retainIfAbsent(toWorkRow('send:message-due-now:prepared', nowMs, nowMs));

        const readyAtMs = await peekOutboundWorkReadyAt(workQueue, NAMESPACE);

        expect(readyAtMs).toBeLessThanOrEqual(Date.now());
    });

    it.each([
        ['a whole page', AL_OUTBOUND_WORK_PAGE_SIZE],
        ['more than a page', AL_OUTBOUND_WORK_PAGE_SIZE + 4]
    ])('claims the work that is due now although %s of ACK timers is due later', async (_label, timers) => {
        const nowMs = Date.now();
        const workQueue = new InMemoryQueueBox(new Map());
        const port = createOutboundWorkPort(workQueue, NAMESPACE);
        for (let timer = 0; timer < timers; timer += 1) {
            await port.retainIfAbsent(toWorkRow(`ack-timeout:message-${timer}:1`, nowMs + ACK_TIMEOUT_MS, nowMs));
        }
        const due = await port.retainIfAbsent(toWorkRow('send:message-due-now:prepared', nowMs, nowMs));

        const claims = await port.claim({ maxCount: AL_OUTBOUND_WORK_PAGE_SIZE, observedEntries: undefined });

        expect(claims.map((claim) => claim.entry.key)).toEqual([due.key]);
    });
});
