import { describe, expect, it } from 'vitest';

import { computeEdgeOrderFigures, type EdgeOrderRunRecords, type EdgeOrderSend } from './compute-edge-order-figures.ts';
import { EdgeOrderSender, type EdgeOrderStamp } from './edge-order-sender.ts';
import type { EdgeOrderArrival, EdgeOrderReplaySettings } from './replay-edge-order-arrivals.ts';

// The measurement's instrument, checked on arrivals written by hand: a figure the Postgres cells report is only as
// good as the replay and the counting behind it. Runs without a database.

const SETTINGS: EdgeOrderReplaySettings = { entryWaitMs: 500, maxHeldPerStream: 256, maxStreams: 256 };
const LIFETIME_MS = 30_000;
const SEND_EVERY_MS = 100;
const FIRST_SEND_AT_MS = 1_000;

/** Position `n` of publisher `p`, sent every 100 ms from 1 000 and stamped as if no earlier send had ended. */
function send(n: number): EdgeOrderSend {
    const sentAtMs = FIRST_SEND_AT_MS + (n - 1) * SEND_EVERY_MS;
    return { publisher: 'p', position: n, sentAtMs, expiresAtMs: sentAtMs + LIFETIME_MS };
}

function stamp(n: number, w = n === 1 ? 0 : send(n - 1).expiresAtMs): EdgeOrderStamp {
    return { s: 'stream', n, w };
}

function arrival(n: number, arrivedAtMs: number, stamped = stamp(n)): EdgeOrderArrival {
    return { publisher: 'p', stamp: stamped, arrivedAtMs, expiresAtMs: send(n).expiresAtMs };
}

function records(positions: number, arrivals: readonly EdgeOrderArrival[]): EdgeOrderRunRecords {
    return {
        sends: Array.from({ length: positions }, (_unused, index) => send(index + 1)),
        peers: ['p', 'r'],
        arrivalsByRecipient: new Map([['r', arrivals]])
    };
}

describe('edge-order figures', () => {
    it('reports arrivals in order as handed over at their read, with nothing held', () => {
        const figures = computeEdgeOrderFigures(records(3, [arrival(1, 1_050), arrival(2, 1_160), arrival(3, 1_270)]), SETTINGS);

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

    it('holds an overtaking message until the one before it arrives, and counts the late one as out of order', () => {
        const figures = computeEdgeOrderFigures(records(3, [arrival(1, 1_050), arrival(3, 1_250), arrival(2, 1_400)]), SETTINGS);

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

    it('starts a stream first seen past position 1 after the entry window, with no gap', () => {
        const figures = computeEdgeOrderFigures(records(3, [arrival(2, 1_150), arrival(3, 1_250)]), SETTINGS);

        expect(figures).toMatchObject({ handedOver: 2, streamsFirstSeenPastOne: 1, gaps: 0, mostHeld: 2 });
        // Both wait for the window that opened at the first read: 1 150 + 500.
        expect(figures.lagMs.sorted).toEqual({ n: 2, p50: 450, p95: 550, max: 550 });
        expect(figures.passRule.everyHandOverBeforeDeadline).toBe(false);
    });

    it('waits for a missing message while its sender says it can arrive, then skips it and reports the gap', () => {
        const lost = send(2);
        const figures = computeEdgeOrderFigures(records(3, [arrival(1, 1_050), arrival(3, 1_250, stamp(3, lost.expiresAtMs))]), SETTINGS);

        expect(figures).toMatchObject({ handedOver: 2, gaps: 1, skippedPositions: 1, lateDrops: 0 });
        expect(figures.lagMs.sorted?.max).toBe(lost.expiresAtMs - send(3).sentAtMs);
    });

    it('does not wait for a message whose sender has seen every earlier send end', () => {
        const figures = computeEdgeOrderFigures(records(3, [arrival(1, 1_050), arrival(3, 1_250, stamp(3, 0)), arrival(2, 1_400)]), SETTINGS);

        expect(figures).toMatchObject({ handedOver: 2, gaps: 1, lateDrops: 1, mostHeld: 0, heldForMs: null });
    });

    it('fails the pass rule when the last ten are slower than one and a half times the first ten', () => {
        const arrivals = Array.from({ length: 20 }, (_unused, index) => arrival(index + 1, send(index + 1).sentAtMs + (index < 10 ? 100 : 160)));

        const figures = computeEdgeOrderFigures(records(20, arrivals), SETTINGS);

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

describe('edge-order sender', () => {
    it('names the latest deadline among the earlier sends it has not seen end', () => {
        const sender = new EdgeOrderSender('stream');

        expect(sender.stamp(31_000)).toEqual({ s: 'stream', n: 1, w: 0 });
        expect(sender.stamp(31_100)).toEqual({ s: 'stream', n: 2, w: 31_000 });
        sender.end(1);
        expect(sender.stamp(31_200)).toEqual({ s: 'stream', n: 3, w: 31_100 });
        sender.end(2);
        sender.end(3);
        expect(sender.stamp(31_300)).toEqual({ s: 'stream', n: 4, w: 0 });
    });
});
