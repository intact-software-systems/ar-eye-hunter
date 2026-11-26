import { assertBoundedHistogram } from '@shared/measurement/assert-bounded-histogram.ts';
import { computeBoundedHistogramAfter, type BoundedHistogram } from '@shared/measurement/bounded-histogram.ts';
import { computeNearestRank } from '@shared/measurement/compute-nearest-rank.ts';
import { computeNumberExtrema } from '@shared/measurement/compute-number-extrema.ts';

import type {
    OrderedSendCellArrival,
    OrderedSendCellObservations,
    OrderedSendCellReceipt,
    OrderedSendCellSend
} from './ordered-send-cell-observations.ts';

/** A percentile is the nearest rank; every figure but the count is null over no samples. */
interface OrderedSendDelayFigures {
    readonly count: number;
    readonly p50: number | null;
    readonly p95: number | null;
    readonly p99: number | null;
    readonly max: number | null;
}

interface OrderedSendSendFigures {
    readonly attempted: number;
    readonly byAcceptance: Readonly<Record<OrderedSendCellSend['acceptance'], number>>;
    /** From a send's due time to the instant it was offered at the entry. */
    readonly latenessMs: OrderedSendDelayFigures;
}

/** A copy is one expected recipient's share of a send; an arrival at a recipient the send did not expect counts nowhere. */
interface OrderedSendDeliveryFigures {
    readonly handedToApplication: number;
    readonly handedMoreThanOnce: number;
    /** Null when no message was handed to the application. */
    readonly largestHandOffMultiplicity: number | null;
    readonly deliveredToEveryRecipient: number;
    readonly deliveredToAnyRecipient: number;
    readonly copiesExpected: number;
    readonly copiesRead: number;
    readonly copiesReadMoreThanOnce: number;
    /** Copies a recipient first read before it first read a copy of an earlier seq of the same publisher. */
    readonly copiesReadOutOfTrackOrder: number;
}

/** From a send's offer at the entry to each expected recipient's first read of its copy. */
interface OrderedSendRecipientDelayFigures extends OrderedSendDelayFigures {
    readonly firstTenSendsP50: number | null;
    readonly lastTenSendsP50: number | null;
    /** Null as well when the first sends' p50 is 0. */
    readonly lastToFirstTenSendsP50Ratio: number | null;
    readonly histogram: BoundedHistogram;
    /** Delays the histogram refused: a copy stamped as read before its send was offered. */
    readonly unrecordedSamples: number;
}

/** A send counts under its first terminal receipt, `complete` or `timed-out`, and under `other` when it read none. */
interface OrderedSendReceiptFigures {
    readonly complete: number;
    readonly timedOut: number;
    readonly other: number;
    readonly moreThanOneTerminal: number;
    readonly sendToAdmittedMs: OrderedSendDelayFigures;
    readonly sendToTerminalMs: OrderedSendDelayFigures;
}

export interface OrderedSendReport {
    readonly sends: OrderedSendSendFigures;
    readonly delivery: OrderedSendDeliveryFigures;
    readonly recipientDelayMs: OrderedSendRecipientDelayFigures;
    readonly receipts: OrderedSendReceiptFigures;
}

const ORDERED_SEND_RECIPIENT_DELAY_BOUNDS_MS: readonly number[] = [
    1,
    2,
    5,
    10,
    20,
    50,
    100,
    200,
    500,
    1_000,
    2_000,
    5_000,
    10_000,
    20_000,
    30_000,
    60_000
];

const EDGE_SEND_COUNT = 10;

const NO_SENDS_BY_ACCEPTANCE: OrderedSendSendFigures['byAcceptance'] = {
    admitted: 0,
    duplicate: 0,
    'resync-required': 0,
    disposed: 0,
    'pending-admission': 0,
    'not-admitted': 0,
    control: 0,
    rejected: 0
};

interface ObservedOrderedSendCopy {
    readonly recipientPeerId: string;
    /** Ascending; empty when the recipient never read its copy. */
    readonly readAtMs: readonly number[];
}

/** A send joined with what the cell observed of it. */
interface ObservedOrderedSend {
    readonly send: OrderedSendCellSend;
    /** One for each expected recipient. */
    readonly copies: readonly ObservedOrderedSendCopy[];
    readonly handOffCount: number;
    /** In the order read. */
    readonly receipts: readonly OrderedSendCellReceipt[];
}

interface OrderedSendTrackRead {
    readonly recipientTrack: string;
    readonly seq: number;
    readonly firstReadAtMs: number;
}

interface OrderedSendRecipientDelayHistogram {
    readonly histogram: BoundedHistogram;
    readonly unrecordedSamples: number;
}

export function computeOrderedSendReport(observations: OrderedSendCellObservations): OrderedSendReport {
    const observedSends = toObservedOrderedSends(observations);
    return {
        sends: computeSendFigures(observations.sends),
        delivery: computeDeliveryFigures(observedSends),
        recipientDelayMs: computeRecipientDelayFigures(observedSends),
        receipts: computeReceiptFigures(observedSends)
    };
}

/** In the order sent. */
function toObservedOrderedSends(observations: OrderedSendCellObservations): readonly ObservedOrderedSend[] {
    const arrivalsByMsgId = Map.groupBy(observations.arrivals, (arrival) => arrival.msgId);
    const handOffsByMsgId = Map.groupBy(observations.handOffs, (handOff) => handOff.msgId);
    const receiptsByMsgId = Map.groupBy(observations.receipts, (receipt) => receipt.msgId);
    return observations.sends.toSorted((left, right) => left.sentAtMs - right.sentAtMs).map((send) => ({
        send,
        copies: toObservedOrderedSendCopies(send, arrivalsByMsgId.get(send.msgId) ?? []),
        handOffCount: handOffsByMsgId.get(send.msgId)?.length ?? 0,
        receipts: (receiptsByMsgId.get(send.msgId) ?? []).toSorted((left, right) => left.atMs - right.atMs)
    }));
}

function toObservedOrderedSendCopies(
    send: OrderedSendCellSend,
    arrivals: readonly OrderedSendCellArrival[]
): readonly ObservedOrderedSendCopy[] {
    const arrivalsByRecipient = Map.groupBy(arrivals, (arrival) => arrival.recipientPeerId);
    return send.expectedRecipientPeerIds.map((recipientPeerId) => ({
        recipientPeerId,
        readAtMs: (arrivalsByRecipient.get(recipientPeerId) ?? [])
            .map((arrival) => arrival.atMs)
            .sort((left, right) => left - right)
    }));
}

function computeOrderedSendDelayFigures(delaysMs: readonly number[]): OrderedSendDelayFigures {
    return {
        count: delaysMs.length,
        p50: computeNearestRank(delaysMs, 0.5) ?? null,
        p95: computeNearestRank(delaysMs, 0.95) ?? null,
        p99: computeNearestRank(delaysMs, 0.99) ?? null,
        max: computeNumberExtrema(delaysMs)?.max ?? null
    };
}

function computeSendFigures(sends: readonly OrderedSendCellSend[]): OrderedSendSendFigures {
    return {
        attempted: sends.length,
        byAcceptance: sends.reduce(
            (counts, send) => ({ ...counts, [send.acceptance]: counts[send.acceptance] + 1 }),
            NO_SENDS_BY_ACCEPTANCE
        ),
        latenessMs: computeOrderedSendDelayFigures(sends.map((send) => send.sentAtMs - send.dueAtMs))
    };
}

function isRead(copy: ObservedOrderedSendCopy): boolean {
    return copy.readAtMs.length > 0;
}

function computeDeliveryFigures(observedSends: readonly ObservedOrderedSend[]): OrderedSendDeliveryFigures {
    const handOffCounts = observedSends.map((observed) => observed.handOffCount).filter((count) => count > 0);
    const copies = observedSends.flatMap((observed) => observed.copies);
    return {
        handedToApplication: handOffCounts.length,
        handedMoreThanOnce: handOffCounts.filter((count) => count > 1).length,
        largestHandOffMultiplicity: computeNumberExtrema(handOffCounts)?.max ?? null,
        deliveredToEveryRecipient: observedSends.filter((observed) => observed.copies.every(isRead)).length,
        deliveredToAnyRecipient: observedSends.filter((observed) => observed.copies.some(isRead)).length,
        copiesExpected: copies.length,
        copiesRead: copies.filter(isRead).length,
        copiesReadMoreThanOnce: copies.filter((copy) => copy.readAtMs.length > 1).length,
        copiesReadOutOfTrackOrder: computeCopiesReadOutOfTrackOrder(observedSends)
    };
}

function computeCopiesReadOutOfTrackOrder(observedSends: readonly ObservedOrderedSend[]): number {
    const reads = observedSends.flatMap(({ send, copies }) =>
        copies.filter(isRead).map((copy): OrderedSendTrackRead => ({
            recipientTrack: JSON.stringify([copy.recipientPeerId, send.publisherPeerId]),
            seq: send.seq,
            firstReadAtMs: copy.readAtMs[0]
        }))
    );
    return [...Map.groupBy(reads, (read) => read.recipientTrack).values()]
        .reduce((total, trackReads) => total + computeReadsBeforeAPredecessor(trackReads), 0);
}

function computeReadsBeforeAPredecessor(trackReads: readonly OrderedSendTrackRead[]): number {
    let latestPredecessorReadAtMs = Number.NEGATIVE_INFINITY;
    let readsBeforeAPredecessor = 0;
    for (const read of trackReads.toSorted((left, right) => left.seq - right.seq)) {
        if (read.firstReadAtMs < latestPredecessorReadAtMs) {
            readsBeforeAPredecessor += 1;
        }
        latestPredecessorReadAtMs = Math.max(latestPredecessorReadAtMs, read.firstReadAtMs);
    }
    return readsBeforeAPredecessor;
}

function computeRecipientDelayFigures(observedSends: readonly ObservedOrderedSend[]): OrderedSendRecipientDelayFigures {
    const delaysMs = computeRecipientDelaysMs(observedSends);
    const firstTenSendsP50 = computeNearestRank(computeRecipientDelaysMs(observedSends.slice(0, EDGE_SEND_COUNT)), 0.5);
    const lastTenSendsP50 = computeNearestRank(computeRecipientDelaysMs(observedSends.slice(-EDGE_SEND_COUNT)), 0.5);
    return {
        ...computeOrderedSendDelayFigures(delaysMs),
        firstTenSendsP50: firstTenSendsP50 ?? null,
        lastTenSendsP50: lastTenSendsP50 ?? null,
        lastToFirstTenSendsP50Ratio: firstTenSendsP50 === undefined || lastTenSendsP50 === undefined ||
                firstTenSendsP50 === 0
            ? null
            : lastTenSendsP50 / firstTenSendsP50,
        ...computeRecipientDelayHistogram(delaysMs)
    };
}

function computeRecipientDelaysMs(observedSends: readonly ObservedOrderedSend[]): readonly number[] {
    return observedSends.flatMap(({ send, copies }) =>
        copies.filter(isRead).map((copy) => copy.readAtMs[0] - send.sentAtMs)
    );
}

function computeRecipientDelayHistogram(delaysMs: readonly number[]): OrderedSendRecipientDelayHistogram {
    const empty = assertBoundedHistogram(
        ORDERED_SEND_RECIPIENT_DELAY_BOUNDS_MS,
        'ORDERED_SEND_RECIPIENT_DELAY_BOUNDS_MS'
    );
    return delaysMs.reduce<OrderedSendRecipientDelayHistogram>((recorded, delayMs) => {
        const after = computeBoundedHistogramAfter(recorded.histogram, delayMs);
        return after.right === undefined
            ? { histogram: recorded.histogram, unrecordedSamples: recorded.unrecordedSamples + 1 }
            : { histogram: after.right, unrecordedSamples: recorded.unrecordedSamples };
    }, { histogram: empty, unrecordedSamples: 0 });
}

function computeReceiptFigures(observedSends: readonly ObservedOrderedSend[]): OrderedSendReceiptFigures {
    const terminalsBySend = observedSends.map((observed) => observed.receipts.filter(isTerminal));
    const firstTerminalPhases = terminalsBySend.map((terminals) => terminals.at(0)?.phase);
    return {
        complete: firstTerminalPhases.filter((phase) => phase === 'complete').length,
        timedOut: firstTerminalPhases.filter((phase) => phase === 'timed-out').length,
        other: firstTerminalPhases.filter((phase) => phase === undefined).length,
        moreThanOneTerminal: terminalsBySend.filter((terminals) => terminals.length > 1).length,
        sendToAdmittedMs: computeOrderedSendDelayFigures(
            computeFirstReceiptDelaysMs(observedSends, (receipt) => receipt.phase === 'admitted')
        ),
        sendToTerminalMs: computeOrderedSendDelayFigures(computeFirstReceiptDelaysMs(observedSends, isTerminal))
    };
}

function isTerminal(receipt: OrderedSendCellReceipt): boolean {
    return receipt.phase !== 'admitted';
}

function computeFirstReceiptDelaysMs(
    observedSends: readonly ObservedOrderedSend[],
    isCounted: (receipt: OrderedSendCellReceipt) => boolean
): readonly number[] {
    return observedSends.flatMap(({ send, receipts }) => {
        const first = receipts.find(isCounted);
        return first === undefined ? [] : [first.atMs - send.sentAtMs];
    });
}
