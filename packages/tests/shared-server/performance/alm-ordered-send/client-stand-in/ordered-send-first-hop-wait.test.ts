import { describe, expect, it } from 'vitest';

import {
    computeOrderedSendFirstHopTurn,
    createOrderedSendFirstHopWait,
    type OrderedSendFirstHopTurn,
    type OrderedSendFirstHopWait
} from '../../../../../../apps/api-v1/scripts/perf/alm-ordered-send/client-stand-in/ordered-send-first-hop-wait.ts';

/** A send offered at 1,000 ms that lives 30 s, under the product's first-hop policy: a 2 s timeout and three retries. */
function createWait(messageExpiresAtMs: number): OrderedSendFirstHopWait {
    return createOrderedSendFirstHopWait({
        msgId: 'session-01-a-send-1',
        tracking: { timeoutMs: 2_000, maxAttempts: 3 },
        offeredAtMs: 1_000,
        messageExpiresAtMs
    });
}

/** The wait a turn leaves: the one it holds on, or the one it was given once that has ended. */
function toNextWait(turn: OrderedSendFirstHopTurn, wait: OrderedSendFirstHopWait): OrderedSendFirstHopWait {
    return turn.kind === 'ended' ? wait : turn.wait;
}

describe('computeOrderedSendFirstHopTurn', () => {
    it('is not due until the first-hop timeout has passed since the offer', () => {
        const wait = createWait(31_000);

        expect(computeOrderedSendFirstHopTurn(wait, 1_000).kind).toBe('waiting');
        expect(computeOrderedSendFirstHopTurn(wait, 2_999.5).kind).toBe('waiting');
        expect(computeOrderedSendFirstHopTurn(wait, 3_000).kind).toBe('resend');
    });

    it('resends at its deadline and then waits a whole timeout from the instant it resent, not from the deadline', () => {
        const lateTurn = computeOrderedSendFirstHopTurn(createWait(31_000), 3_012.5);

        expect(lateTurn.kind).toBe('resend');
        const resent = toNextWait(lateTurn, createWait(31_000));
        expect(resent.snapshot.attempts).toBe(1);
        expect(resent.snapshot.deadlineAtMs).toBe(5_012.5);
        expect(computeOrderedSendFirstHopTurn(resent, 5_012).kind).toBe('waiting');
    });

    it('resends three times, two seconds apart, and ends at the deadline after the third', () => {
        const turns: [string, number][] = [];
        let wait = createWait(31_000);
        for (const nowMs of [3_000, 5_000, 7_000, 9_000, 11_000]) {
            const turn = computeOrderedSendFirstHopTurn(wait, nowMs);
            wait = toNextWait(turn, wait);
            turns.push([turn.kind, wait.snapshot.attempts]);
        }

        expect(turns).toEqual([['resend', 1], ['resend', 2], ['resend', 3], ['ended', 3], ['ended', 3]]);
    });

    it('ends without a resend once its message\'s lifetime is over', () => {
        expect(computeOrderedSendFirstHopTurn(createWait(3_000), 3_000).kind).toBe('ended');
        expect(computeOrderedSendFirstHopTurn(createWait(3_000.5), 3_000).kind).toBe('resend');
    });
});
