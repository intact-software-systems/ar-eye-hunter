import { computeNearestRank } from '@shared/measurement/compute-nearest-rank.ts';

import {
    computeOrderedSendDelaySummary,
    isOrderedSendDelaySample,
    type OrderedSendDelaySummary
} from './compute-ordered-send-delay-summary.ts';
import type { ObservedOrderedSend } from './to-observed-ordered-sends.ts';

/**
 * The nearest-rank percentiles of a delay over expected copies, read or not. A copy never read ranks above every
 * read one, so a percentile is null when its rank lands on a copy never read, as it is over no copies.
 */
export interface OrderedSendExpectedCopyDelayFigures {
    readonly count: number;
    readonly p50: number | null;
    readonly p95: number | null;
    readonly p99: number | null;
}

/**
 * Whether the delay grew over the run: the p50 from due time to first read over the expected copies of the ten
 * sends due first and of the ten due last. All three are null under twenty sends, where the two tens would overlap.
 */
export interface OrderedSendEdgeDelayFigures {
    readonly firstTenSendsP50Ms: number | null;
    readonly lastTenSendsP50Ms: number | null;
    /** Null as well when either p50 is null or the first is 0. */
    readonly lastToFirstTenSendsP50Ratio: number | null;
}

/**
 * How long each expected recipient waited for its copy, to its first read. A copy read before its send was offered
 * has no trustworthy read instant: it is in no delay figure, on either base, and counted apart.
 */
export interface OrderedSendRecipientDelayFigures extends OrderedSendEdgeDelayFigures {
    /** Every copy read at or after its offer, from its send's due time: what a recipient waited, lateness included. */
    readonly dueToFirstReadMs: OrderedSendDelaySummary;
    /** The copies `dueToFirstReadMs` samples and every expected copy never read, from its send's due time. */
    readonly dueToFirstReadOverExpectedCopiesMs: OrderedSendExpectedCopyDelayFigures;
    /** Every copy read at or after its offer, from that offer at the entry: the server's path alone. */
    readonly offerToFirstReadMs: OrderedSendDelaySummary;
    /** The copies `offerToFirstReadMs` samples and every expected copy never read, from its send's offer. */
    readonly offerToFirstReadOverExpectedCopiesMs: OrderedSendExpectedCopyDelayFigures;
    /** Expected copies whose first read carries an instant before their send's offer. */
    readonly copiesReadBeforeTheirOffer: number;
}

/** The first reads of the expected copies of some sends, on both bases. */
interface OrderedSendFirstReads {
    readonly dueToFirstReadMs: readonly number[];
    readonly offerToFirstReadMs: readonly number[];
    readonly copiesNeverRead: number;
    readonly copiesReadBeforeTheirOffer: number;
}

const EDGE_SEND_COUNT = 10;

export function computeOrderedSendRecipientDelayFigures(
    observedSends: readonly ObservedOrderedSend[]
): OrderedSendRecipientDelayFigures {
    const firstReads = toOrderedSendFirstReads(observedSends);
    return {
        dueToFirstReadMs: computeOrderedSendDelaySummary(firstReads.dueToFirstReadMs),
        dueToFirstReadOverExpectedCopiesMs: computeExpectedCopyDelayFigures(
            firstReads.dueToFirstReadMs,
            firstReads.copiesNeverRead
        ),
        offerToFirstReadMs: computeOrderedSendDelaySummary(firstReads.offerToFirstReadMs),
        offerToFirstReadOverExpectedCopiesMs: computeExpectedCopyDelayFigures(
            firstReads.offerToFirstReadMs,
            firstReads.copiesNeverRead
        ),
        copiesReadBeforeTheirOffer: firstReads.copiesReadBeforeTheirOffer,
        ...computeEdgeDelayFigures(observedSends)
    };
}

function toOrderedSendFirstReads(observedSends: readonly ObservedOrderedSend[]): OrderedSendFirstReads {
    const expectedCopies = observedSends.flatMap(({ send, copies }) => copies.map((copy) => ({ send, copy })));
    const firstReads = expectedCopies.flatMap(({ send, copy }) =>
        copy.reads.slice(0, 1).map((firstRead) => ({ send, firstReadAtMs: firstRead.atMs }))
    );
    const firstReadsAfterTheirOffer = firstReads.filter(({ send, firstReadAtMs }) => firstReadAtMs >= send.sentAtMs);
    return {
        dueToFirstReadMs: firstReadsAfterTheirOffer.map(({ send, firstReadAtMs }) => firstReadAtMs - send.dueAtMs),
        offerToFirstReadMs: firstReadsAfterTheirOffer.map(({ send, firstReadAtMs }) => firstReadAtMs - send.sentAtMs),
        copiesNeverRead: expectedCopies.length - firstReads.length,
        copiesReadBeforeTheirOffer: firstReads.length - firstReadsAfterTheirOffer.length
    };
}

function computeExpectedCopyDelayFigures(
    delaysMs: readonly number[],
    copiesNeverRead: number
): OrderedSendExpectedCopyDelayFigures {
    const rankedDelaysMs = [
        ...delaysMs.filter(isOrderedSendDelaySample),
        ...new Array<number>(copiesNeverRead).fill(Number.POSITIVE_INFINITY)
    ];
    return {
        count: rankedDelaysMs.length,
        p50: computeRankAmongExpectedCopies(rankedDelaysMs, 0.5),
        p95: computeRankAmongExpectedCopies(rankedDelaysMs, 0.95),
        p99: computeRankAmongExpectedCopies(rankedDelaysMs, 0.99)
    };
}

/**
 * A copy never read waits without end, so it ranks as an infinite delay, above every sample. That infinity never
 * leaves here: a rank that lands on it is null.
 */
function computeRankAmongExpectedCopies(rankedDelaysMs: readonly number[], fraction: number): number | null {
    const rankedDelayMs = computeNearestRank(rankedDelaysMs, fraction);
    return rankedDelayMs === undefined || rankedDelayMs === Number.POSITIVE_INFINITY ? null : rankedDelayMs;
}

function computeEdgeDelayFigures(observedSends: readonly ObservedOrderedSend[]): OrderedSendEdgeDelayFigures {
    if (observedSends.length < 2 * EDGE_SEND_COUNT) {
        return { firstTenSendsP50Ms: null, lastTenSendsP50Ms: null, lastToFirstTenSendsP50Ratio: null };
    }
    const sendsInDueOrder = observedSends.toSorted((left, right) => left.send.dueAtMs - right.send.dueAtMs);
    const firstTenSendsP50Ms = computeDueToFirstReadP50Ms(sendsInDueOrder.slice(0, EDGE_SEND_COUNT));
    const lastTenSendsP50Ms = computeDueToFirstReadP50Ms(sendsInDueOrder.slice(-EDGE_SEND_COUNT));
    return {
        firstTenSendsP50Ms,
        lastTenSendsP50Ms,
        lastToFirstTenSendsP50Ratio: firstTenSendsP50Ms === null || lastTenSendsP50Ms === null ||
                firstTenSendsP50Ms === 0
            ? null
            : lastTenSendsP50Ms / firstTenSendsP50Ms
    };
}

function computeDueToFirstReadP50Ms(observedSends: readonly ObservedOrderedSend[]): number | null {
    const firstReads = toOrderedSendFirstReads(observedSends);
    return computeExpectedCopyDelayFigures(firstReads.dueToFirstReadMs, firstReads.copiesNeverRead).p50;
}
