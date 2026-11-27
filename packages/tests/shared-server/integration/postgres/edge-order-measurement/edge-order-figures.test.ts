import { describe, expect, it } from 'vitest';

import { EDGE_ORDER_RECEIVER_DEFAULT_LIMITS } from '@shared-web/browser/messages/edge-order/edge-order-receiver-limits.ts';
import type { EdgeOrderStamp } from '@shared-web/browser/messages/edge-order/edge-order-stamp.ts';

import { computeEdgeOrderFigures, type EdgeOrderRunRecords, type EdgeOrderSend } from './compute-edge-order-figures.ts';
import type { EdgeOrderArrival } from './replay-edge-order-arrivals.ts';

// The measurement's instrument, checked on arrivals written by hand: a figure the Postgres cells report is only as
// good as the replay and the counting behind it. Runs without a database.

const LIMITS = EDGE_ORDER_RECEIVER_DEFAULT_LIMITS;
const LIFETIME_MS = 30_000;
const SEND_EVERY_MS = 100;
const FIRST_SEND_AT_MS = 1_000;

/** Position `n` of publisher `p`, sent every 100 ms from 1 000 and stamped as if no earlier send had ended. */
function send(n: number): EdgeOrderSend {
    const sentAtMs = FIRST_SEND_AT_MS + (n - 1) * SEND_EVERY_MS;
    return { publisher: 'p', position: n, sentAtMs, expiresAtMs: sentAtMs + LIFETIME_MS };
}

/** A stamp whose sender has seen no earlier send end: an earlier one can arrive until `earlierCanArriveUntilMs`. */
function stamp(n: number, earlierCanArriveUntilMs = send(Math.max(1, n - 1)).expiresAtMs): EdgeOrderStamp {
    return n === 1
        ? stampAfterEveryEnd(n)
        : { stream: 'stream', position: n, lowestOpenPosition: 1, earlierCanArriveUntilMs, holes: [] };
}

/** A stamp whose sender has seen every earlier send end. */
function stampAfterEveryEnd(n: number): EdgeOrderStamp {
    return { stream: 'stream', position: n, lowestOpenPosition: n, earlierCanArriveUntilMs: undefined, holes: [] };
}

function arrival(n: number, arrivedAtMs: number, stamped = stamp(n)): EdgeOrderArrival {
    return { publisher: 'p', stamp: stamped, arrivedAtMs, expiresAtMs: send(n).expiresAtMs, byteLength: 100 };
}

function records(positions: number, arrivals: readonly EdgeOrderArrival[]): EdgeOrderRunRecords {
    return {
        sends: Array.from({ length: positions }, (_unused, index) => send(index + 1)),
        peers: ['p', 'r'],
        arrivalsByRecipient: new Map([['r', arrivals]])
    };
}

describe('edge-order figures', () => {
    it('reports arrivals in order as handed over at their read, with nothing held', async () => {
        const figures = await computeEdgeOrderFigures(records(3, [arrival(1, 1_050), arrival(2, 1_160), arrival(3, 1_270)]), LIMITS);

        expect(figures).toMatchObject({
            expectedHandOvers: 3,
            handedOver: 3,
            handedOverBeforeDeadline: 3,
            outOfOrderArrivals: 0,
            mostHeld: 0,
            heldForMs: null,
            gaps: 0,
            lateDrops: 0
        });
        expect(figures.lagMs).toEqual({ raw: { n: 3, p50: 60, p95: 70, max: 70 }, sorted: { n: 3, p50: 60, p95: 70, max: 70 } });
    });

    it('holds an overtaking message until the one before it arrives, and counts the late one as out of order', async () => {
        const figures = await computeEdgeOrderFigures(records(3, [arrival(1, 1_050), arrival(3, 1_250), arrival(2, 1_400)]), LIMITS);

        expect(figures).toMatchObject({
            handedOver: 3,
            outOfOrderArrivals: 1,
            outOfOrderShare: 0.333,
            overtakenByMs: { n: 1, p50: 150, p95: 150, max: 150 },
            mostHeld: 1,
            heldForMs: { n: 1, p50: 150, p95: 150, max: 150 },
            gaps: 0
        });
        // Position 3 was read 50 ms after its send and handed over 200 ms after it, behind position 2.
        expect(figures.lagMs.raw?.max).toBe(300);
        expect(figures.lagMs.sorted).toEqual({ n: 3, p50: 200, p95: 300, max: 300 });
    });

    it('starts a stream first seen past position 1 after the entry window, with no gap', async () => {
        const figures = await computeEdgeOrderFigures(records(3, [arrival(2, 1_150), arrival(3, 1_250)]), LIMITS);

        expect(figures).toMatchObject({ handedOver: 2, streamsFirstSeenPastOne: 1, gaps: 0, mostHeld: 2 });
        // Both wait for the window that opened at the first read: 1 150 + 500.
        expect(figures.lagMs.sorted).toEqual({ n: 2, p50: 450, p95: 550, max: 550 });
        expect(figures.passRule.everyHandOverBeforeDeadline).toBe(false);
    });

    it('waits for a missing message while its sender says it can arrive, then skips it and reports the gap', async () => {
        const lost = send(2);
        const figures = await computeEdgeOrderFigures(records(3, [arrival(1, 1_050), arrival(3, 1_250, stamp(3, lost.expiresAtMs))]), LIMITS);

        expect(figures).toMatchObject({ handedOver: 2, gaps: 1, skippedPositions: 1, lateDrops: 0 });
        expect(figures.lagMs.sorted?.max).toBe(lost.expiresAtMs - send(3).sentAtMs);
    });

    it('does not wait for a message whose sender has seen every earlier send end', async () => {
        const figures = await computeEdgeOrderFigures(records(3, [arrival(1, 1_050), arrival(3, 1_250, stampAfterEveryEnd(3)), arrival(2, 1_400)]), LIMITS);

        expect(figures).toMatchObject({ handedOver: 2, gaps: 1, lateDrops: 1, mostHeld: 0, heldForMs: null });
    });

    it('fails the pass rule when the last ten are slower than one and a half times the first ten', async () => {
        const arrivals = Array.from({ length: 20 }, (_unused, index) => arrival(index + 1, send(index + 1).sentAtMs + (index < 10 ? 100 : 160)));

        const figures = await computeEdgeOrderFigures(records(20, arrivals), LIMITS);

        expect(figures.firstTenLagMs.sorted?.p50).toBe(100);
        expect(figures.lastTenLagMs.sorted?.p50).toBe(160);
        expect(figures.passRule).toEqual({
            everyHandOverBeforeDeadline: true,
            sortedP95WithinLimit: true,
            lastTenWithinRatio: false,
            passes: false
        });
    });
});
