import {
    replayEdgeOrderArrivals,
    type EdgeOrderArrival,
    type EdgeOrderReplay,
    type EdgeOrderReplaySettings
} from './replay-edge-order-arrivals.ts';

/** One room message as its publisher sent it. Times are epoch milliseconds, with a fraction. */
export interface EdgeOrderSend {
    readonly publisher: string;
    /** Its position on its publisher's stream, from 1. */
    readonly position: number;
    readonly sentAtMs: number;
    readonly expiresAtMs: number;
}

/** What one run recorded: the sends, and what every session read. */
export interface EdgeOrderRunRecords {
    /** In send order. */
    readonly sends: readonly EdgeOrderSend[];
    /** Every session of the room; a message's recipients are all of them but its publisher. */
    readonly peers: readonly string[];
    /** Each session's first reads of room messages, in arrival order. */
    readonly arrivalsByRecipient: ReadonlyMap<string, readonly EdgeOrderArrival[]>;
}

export interface EdgeOrderSummary {
    readonly n: number;
    readonly p50: number;
    readonly p95: number;
    readonly max: number;
}

/** Lag from the send, in milliseconds: to the recipient's read, and to the receiver's hand-over after sorting. */
export interface EdgeOrderLags {
    readonly raw: EdgeOrderSummary | null;
    readonly sorted: EdgeOrderSummary | null;
}

/** The plan's pass rule for a cell (`plans/active/edge-ordered-room-sends.md`, section 2.5). */
export interface EdgeOrderPassRule {
    readonly everyHandOverBeforeDeadline: boolean;
    readonly sortedP95WithinLimit: boolean;
    readonly lastTenWithinRatio: boolean;
    readonly passes: boolean;
}

export interface EdgeOrderFigures {
    readonly messages: number;
    /** One for each message and each of its recipients. */
    readonly expectedHandOvers: number;
    readonly arrivals: number;
    readonly handedOver: number;
    readonly handedOverBeforeDeadline: number;
    /** Arrivals whose position is below one the same recipient had already read from that stream. */
    readonly outOfOrderArrivals: number;
    readonly outOfOrderShare: number;
    readonly outOfOrderSharePerRecipient: { readonly min: number; readonly median: number; readonly max: number; };
    /** For each out-of-order arrival: how long after the first later message of its stream it arrived. */
    readonly overtakenByMs: EdgeOrderSummary | null;
    /** Recipient streams whose first arrival was past position 1: the ones ruling 2's entry window is for. */
    readonly streamsFirstSeenPastOne: number;
    readonly lagMs: EdgeOrderLags;
    readonly firstTenLagMs: EdgeOrderLags;
    readonly lastTenLagMs: EdgeOrderLags;
    /** Hand-overs the receiver held back, and for how long. */
    readonly heldForMs: EdgeOrderSummary | null;
    /** The most messages one recipient's receiver held at once. */
    readonly mostHeld: number;
    readonly gaps: number;
    readonly skippedPositions: number;
    readonly lateDrops: number;
    readonly passRule: EdgeOrderPassRule;
}

const SORTED_P95_LIMIT_MS = 1_000;
const LAST_TO_FIRST_TEN_LIMIT = 1.5;
const EDGE_OF_RUN_MESSAGES = 10;

interface MeasuredHandOver {
    readonly send: EdgeOrderSend;
    readonly rawLagMs: number;
    readonly sortedLagMs: number;
    readonly heldForMs: number;
    readonly beforeDeadline: boolean;
}

interface ArrivalOrder {
    readonly arrivals: number;
    readonly outOfOrder: number;
    readonly overtakenByMs: readonly number[];
    readonly streamsFirstSeenPastOne: number;
}

const toSendKey = (publisher: string, position: number) => `${publisher}\n${position}`;
const round1 = (value: number) => Math.round(value * 10) / 10;

/** Nearest-rank percentiles, to a tenth of a millisecond; null for no values. */
export function summarizeEdgeOrderValues(values: readonly number[]): EdgeOrderSummary | null {
    if (values.length === 0) {
        return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]!;
    return { n: sorted.length, p50: round1(at(0.5)), p95: round1(at(0.95)), max: round1(sorted[sorted.length - 1]!) };
}

/** One recipient's arrival order, stream by stream, before any sorting. */
function computeArrivalOrder(arrivals: readonly EdgeOrderArrival[]): ArrivalOrder {
    const seenByStream = new Map<string, { n: number; arrivedAtMs: number; }[]>();
    const overtakenByMs: number[] = [];
    let streamsFirstSeenPastOne = 0;
    for (const arrival of arrivals) {
        const key = `${arrival.publisher}\n${arrival.stamp.s}`;
        const seen = seenByStream.get(key) ?? [];
        seenByStream.set(key, seen);
        if (seen.length === 0 && arrival.stamp.n !== 1) {
            streamsFirstSeenPastOne += 1;
        }
        const firstLater = seen.find((earlier) => earlier.n > arrival.stamp.n);
        if (firstLater !== undefined) {
            overtakenByMs.push(arrival.arrivedAtMs - firstLater.arrivedAtMs);
        }
        seen.push({ n: arrival.stamp.n, arrivedAtMs: arrival.arrivedAtMs });
    }
    return { arrivals: arrivals.length, outOfOrder: overtakenByMs.length, overtakenByMs, streamsFirstSeenPastOne };
}

function toMeasuredHandOvers(replay: EdgeOrderReplay, sends: ReadonlyMap<string, EdgeOrderSend>): MeasuredHandOver[] {
    return replay.handOvers.map(({ arrival, handedOverAtMs }) => {
        const send = sends.get(toSendKey(arrival.publisher, arrival.stamp.n));
        if (send === undefined) {
            throw new Error(`An arrival names position ${arrival.stamp.n} of ${arrival.publisher}, which was not sent`);
        }
        return {
            send,
            rawLagMs: arrival.arrivedAtMs - send.sentAtMs,
            sortedLagMs: handedOverAtMs - send.sentAtMs,
            heldForMs: handedOverAtMs - arrival.arrivedAtMs,
            beforeDeadline: handedOverAtMs < send.expiresAtMs
        };
    });
}

function toLags(handOvers: readonly MeasuredHandOver[]): EdgeOrderLags {
    return {
        raw: summarizeEdgeOrderValues(handOvers.map((handOver) => handOver.rawLagMs)),
        sorted: summarizeEdgeOrderValues(handOvers.map((handOver) => handOver.sortedLagMs))
    };
}

function toPassRule(
    input: Pick<EdgeOrderFigures, 'expectedHandOvers' | 'handedOverBeforeDeadline' | 'lagMs' | 'firstTenLagMs' | 'lastTenLagMs'>
): EdgeOrderPassRule {
    const first = input.firstTenLagMs.sorted;
    const last = input.lastTenLagMs.sorted;
    const everyHandOverBeforeDeadline = input.handedOverBeforeDeadline === input.expectedHandOvers;
    const sortedP95WithinLimit = input.lagMs.sorted !== null && input.lagMs.sorted.p95 <= SORTED_P95_LIMIT_MS;
    const lastTenWithinRatio = first !== null && last !== null && last.p50 <= LAST_TO_FIRST_TEN_LIMIT * first.p50;
    return {
        everyHandOverBeforeDeadline,
        sortedP95WithinLimit,
        lastTenWithinRatio,
        passes: everyHandOverBeforeDeadline && sortedP95WithinLimit && lastTenWithinRatio
    };
}

function toShareSpread(shares: readonly number[]): EdgeOrderFigures['outOfOrderSharePerRecipient'] {
    const sorted = [...shares].sort((a, b) => a - b);
    const round = (value: number | undefined) => Math.round((value ?? 0) * 1000) / 1000;
    return { min: round(sorted[0]), median: round(sorted[Math.floor(sorted.length / 2)]), max: round(sorted[sorted.length - 1]) };
}

/**
 * The run's figures: each recipient's arrival order as read, then what the edge-order receiver would have handed
 * its application and when, against the plan's pass rule.
 */
export function computeEdgeOrderFigures(records: EdgeOrderRunRecords, settings: EdgeOrderReplaySettings): EdgeOrderFigures {
    const sends = new Map(records.sends.map((send) => [toSendKey(send.publisher, send.position), send]));
    // A session that read nothing (a lone publisher) has no arrival order to report.
    const recipients = [...records.arrivalsByRecipient.values()].filter((arrivals) => arrivals.length > 0);
    const orders = recipients.map(computeArrivalOrder);
    const replays = recipients.map((arrivals) => replayEdgeOrderArrivals(arrivals, settings));
    const handOvers = replays.flatMap((replay) => toMeasuredHandOvers(replay, sends));
    const arrivals = orders.reduce((sum, order) => sum + order.arrivals, 0);
    const outOfOrderArrivals = orders.reduce((sum, order) => sum + order.outOfOrder, 0);
    const edgeOf = (edge: readonly EdgeOrderSend[]) => toLags(handOvers.filter((handOver) => edge.includes(handOver.send)));
    const gaps = replays.flatMap((replay) => replay.gaps);
    const measured = {
        expectedHandOvers: records.sends.length * (records.peers.length - 1),
        handedOverBeforeDeadline: handOvers.filter((handOver) => handOver.beforeDeadline).length,
        lagMs: toLags(handOvers),
        firstTenLagMs: edgeOf(records.sends.slice(0, EDGE_OF_RUN_MESSAGES)),
        lastTenLagMs: edgeOf(records.sends.slice(-EDGE_OF_RUN_MESSAGES))
    };
    return {
        messages: records.sends.length,
        arrivals,
        handedOver: handOvers.length,
        outOfOrderArrivals,
        outOfOrderShare: arrivals === 0 ? 0 : Math.round((outOfOrderArrivals / arrivals) * 1000) / 1000,
        outOfOrderSharePerRecipient: toShareSpread(orders.map((order) => order.arrivals === 0 ? 0 : order.outOfOrder / order.arrivals)),
        overtakenByMs: summarizeEdgeOrderValues(orders.flatMap((order) => order.overtakenByMs)),
        streamsFirstSeenPastOne: orders.reduce((sum, order) => sum + order.streamsFirstSeenPastOne, 0),
        heldForMs: summarizeEdgeOrderValues(handOvers.filter((handOver) => handOver.heldForMs > 0).map((handOver) => handOver.heldForMs)),
        mostHeld: Math.max(0, ...replays.map((replay) => replay.mostHeld)),
        gaps: gaps.length,
        skippedPositions: gaps.reduce((sum, gap) => sum + gap.to - gap.from + 1, 0),
        lateDrops: replays.reduce((sum, replay) => sum + replay.lateDrops, 0),
        ...measured,
        passRule: toPassRule(measured)
    };
}
