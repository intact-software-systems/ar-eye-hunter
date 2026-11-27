import type {
    EdgeOrderHeldMessage,
    EdgeOrderReceivedStream
} from '@shared-web/browser/messages/edge-order/edge-order-received-stream.ts';
import type { EdgeOrderReceiverLimits } from '@shared-web/browser/messages/edge-order/edge-order-receiver-limits.ts';
import type { RallarMessageOrderGapReason } from '@shared-web/browser/messages/rallar-message-contracts.ts';

/**
 * What a stream does next. `start` and `skip` both continue the stream at `nextPosition`; `skip` also gives up the
 * positions from `fromPosition` up to it.
 */
export type EdgeOrderStreamStep<Message> =
    | { readonly kind: 'rest'; }
    | { readonly kind: 'wait'; readonly untilMs: number; }
    | { readonly kind: 'hand-over'; readonly held: EdgeOrderHeldMessage<Message>; }
    | { readonly kind: 'start'; readonly nextPosition: number; }
    | {
        readonly kind: 'skip';
        readonly fromPosition: number;
        readonly nextPosition: number;
        readonly reason: RallarMessageOrderGapReason;
    };

/** When the stream must stop holding its lowest message whatever is still missing, and why. */
interface EdgeOrderHeldRelease {
    readonly atMs: number;
    readonly reason: RallarMessageOrderGapReason;
}

interface EdgeOrderHoldingStream<Message> {
    readonly stream: Readonly<EdgeOrderReceivedStream<Message>>;
    readonly lowest: EdgeOrderHeldMessage<Message>;
    readonly release: EdgeOrderHeldRelease;
    readonly nowMs: number;
}

/** A message is handed over at the latest this long before its deadline, the first instant it would be expired. */
const HAND_OVER_LEAD_MS = 1;

export function computeEdgeOrderStreamStep<Message>(
    stream: Readonly<EdgeOrderReceivedStream<Message>>,
    nowMs: number,
    limits: EdgeOrderReceiverLimits
): EdgeOrderStreamStep<Message> {
    const next = stream.nextPosition === undefined ? undefined : stream.held.get(stream.nextPosition);
    if (next !== undefined) {
        return { kind: 'hand-over', held: next };
    }
    const lowest = resolveLowestHeld(stream.held);
    const endedSkip = stream.nextPosition === undefined
        ? undefined
        : computeEndedSkip(stream, stream.nextPosition, lowest);
    if (endedSkip !== undefined) {
        return endedSkip;
    }
    if (lowest === undefined) {
        return { kind: 'rest' };
    }
    const holding = { stream, lowest, release: computeHeldRelease(stream, limits), nowMs };
    return stream.nextPosition === undefined
        ? computeEntryStep(holding)
        : computeGapStep(holding, stream.nextPosition);
}

/** The skip past the positions from `nextPosition` up that the sender has said are over; absent when it said none. */
function computeEndedSkip<Message>(
    stream: Readonly<EdgeOrderReceivedStream<Message>>,
    nextPosition: number,
    lowest: EdgeOrderHeldMessage<Message> | undefined
): EdgeOrderStreamStep<Message> | undefined {
    const firstOpenPosition = computeFirstOpenPosition(stream, nextPosition);
    if (firstOpenPosition === nextPosition) {
        return undefined;
    }
    return {
        kind: 'skip',
        fromPosition: nextPosition,
        // A held message is never passed: a send cancelled after a copy of it arrived is still handed over.
        nextPosition: Math.min(firstOpenPosition, lowest?.stamp.position ?? firstOpenPosition),
        reason: 'ended-at-sender'
    };
}

/**
 * The first position from `fromPosition` up that the sender has not said is over: every position below the highest
 * `lowestOpenPosition` it stated has ended, and so has every hole the stamp of a held message states.
 */
function computeFirstOpenPosition<Message>(
    stream: Readonly<EdgeOrderReceivedStream<Message>>,
    fromPosition: number
): number {
    const holes = [...stream.held.values()]
        .flatMap((held) => held.stamp.holes)
        .sort((left, right) => left[0] - right[0]);
    let firstOpenPosition = Math.max(fromPosition, stream.endedBelowPosition);
    for (const [fromHole, toHole] of holes) {
        if (fromHole > firstOpenPosition) {
            break;
        }
        firstOpenPosition = Math.max(firstOpenPosition, toHole + 1);
    }
    return firstOpenPosition;
}

function computeEntryStep<Message>(holding: EdgeOrderHoldingStream<Message>): EdgeOrderStreamStep<Message> {
    const { stream, lowest, nowMs } = holding;
    const entryEndsAtMs = Math.min(
        stream.firstSeenAtMs + stream.waits.orderEntryWindowMs,
        lowest.stamp.earlierCanArriveUntilMs ?? nowMs,
        holding.release.atMs
    );
    return entryEndsAtMs > nowMs && lowest.stamp.position > stream.endedBelowPosition
        ? { kind: 'wait', untilMs: entryEndsAtMs }
        : { kind: 'start', nextPosition: lowest.stamp.position };
}

function computeGapStep<Message>(
    holding: EdgeOrderHoldingStream<Message>,
    fromPosition: number
): EdgeOrderStreamStep<Message> {
    const arrivalEnd: EdgeOrderHeldRelease = {
        atMs: holding.lowest.stamp.earlierCanArriveUntilMs ?? holding.nowMs,
        reason: 'cannot-arrive'
    };
    const waitEnd = holding.release.atMs < arrivalEnd.atMs ? holding.release : arrivalEnd;
    return waitEnd.atMs > holding.nowMs
        ? { kind: 'wait', untilMs: waitEnd.atMs }
        : { kind: 'skip', fromPosition, nextPosition: holding.lowest.stamp.position, reason: waitEnd.reason };
}

function computeHeldRelease<Message>(
    stream: Readonly<EdgeOrderReceivedStream<Message>>,
    limits: EdgeOrderReceiverLimits
): EdgeOrderHeldRelease {
    const pastCapReason = resolvePastCapReason(stream, limits);
    if (pastCapReason !== undefined) {
        return { atMs: Number.NEGATIVE_INFINITY, reason: pastCapReason };
    }
    let earliest: EdgeOrderHeldRelease = { atMs: Number.POSITIVE_INFINITY, reason: 'held-message-deadline' };
    for (const held of stream.held.values()) {
        const release = computeHeldMessageRelease(held, stream.waits.orderGapWaitMs);
        if (release.atMs < earliest.atMs) {
            earliest = release;
        }
    }
    return earliest;
}

function computeHeldMessageRelease<Message>(
    held: EdgeOrderHeldMessage<Message>,
    orderGapWaitMs: number | undefined
): EdgeOrderHeldRelease {
    const deadlineAtMs = held.expiresAtMs - HAND_OVER_LEAD_MS;
    const capAtMs = orderGapWaitMs === undefined ? Number.POSITIVE_INFINITY : held.heldSinceMs + orderGapWaitMs;
    return capAtMs < deadlineAtMs
        ? { atMs: capAtMs, reason: 'channel-wait-cap' }
        : { atMs: deadlineAtMs, reason: 'held-message-deadline' };
}

function resolvePastCapReason<Message>(
    stream: Readonly<EdgeOrderReceivedStream<Message>>,
    limits: EdgeOrderReceiverLimits
): RallarMessageOrderGapReason | undefined {
    if (stream.forgotten) {
        return 'stream-cap';
    }
    if (stream.held.size > limits.maxHeldMessagesPerStream) {
        return 'held-message-cap';
    }
    return stream.heldBytes > limits.maxHeldBytesPerStream ? 'held-byte-cap' : undefined;
}

function resolveLowestHeld<Message>(
    held: ReadonlyMap<number, EdgeOrderHeldMessage<Message>>
): EdgeOrderHeldMessage<Message> | undefined {
    let lowest: EdgeOrderHeldMessage<Message> | undefined;
    for (const candidate of held.values()) {
        if (lowest === undefined || candidate.stamp.position < lowest.stamp.position) {
            lowest = candidate;
        }
    }
    return lowest;
}
