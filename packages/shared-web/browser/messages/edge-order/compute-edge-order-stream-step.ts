import type { EdgeOrderGapReason } from '@shared-web/browser/messages/edge-order/edge-order-gap.ts';
import type {
    EdgeOrderHeldMessage,
    EdgeOrderReceivedStream
} from '@shared-web/browser/messages/edge-order/edge-order-received-stream.ts';
import type { EdgeOrderReceiverLimits } from '@shared-web/browser/messages/edge-order/edge-order-receiver-limits.ts';

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
        readonly reason: EdgeOrderGapReason;
    };

/** When the stream must stop holding its lowest message whatever is still missing, and why. */
interface EdgeOrderHeldRelease {
    readonly atMs: number;
    readonly reason: EdgeOrderGapReason;
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
    if (stream.nextPosition !== undefined && stream.endedBelowPosition > stream.nextPosition) {
        return {
            kind: 'skip',
            fromPosition: stream.nextPosition,
            nextPosition: Math.min(stream.endedBelowPosition, lowest?.stamp.position ?? stream.endedBelowPosition),
            reason: 'ended-at-sender'
        };
    }
    if (lowest === undefined) {
        return { kind: 'rest' };
    }
    const holding = { stream, lowest, release: computeHeldRelease(stream, limits), nowMs };
    return stream.nextPosition === undefined
        ? computeEntryStep(holding, limits.entryWaitMs)
        : computeGapStep(holding, stream.nextPosition);
}

function computeEntryStep<Message>(
    holding: EdgeOrderHoldingStream<Message>,
    entryWaitMs: number
): EdgeOrderStreamStep<Message> {
    const { stream, lowest, nowMs } = holding;
    const entryEndsAtMs = Math.min(
        stream.firstSeenAtMs + entryWaitMs,
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
        const release = toHeldMessageRelease(held, limits.gapWaitCapMs);
        if (release.atMs < earliest.atMs) {
            earliest = release;
        }
    }
    return earliest;
}

function toHeldMessageRelease<Message>(
    held: EdgeOrderHeldMessage<Message>,
    gapWaitCapMs: number | undefined
): EdgeOrderHeldRelease {
    const deadlineAtMs = held.expiresAtMs - HAND_OVER_LEAD_MS;
    const capAtMs = gapWaitCapMs === undefined ? Number.POSITIVE_INFINITY : held.heldSinceMs + gapWaitCapMs;
    return capAtMs < deadlineAtMs
        ? { atMs: capAtMs, reason: 'channel-wait-cap' }
        : { atMs: deadlineAtMs, reason: 'held-message-deadline' };
}

function resolvePastCapReason<Message>(
    stream: Readonly<EdgeOrderReceivedStream<Message>>,
    limits: EdgeOrderReceiverLimits
): EdgeOrderGapReason | undefined {
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
