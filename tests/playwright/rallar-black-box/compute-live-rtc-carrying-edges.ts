import type { AgentPrefix } from './live-rtc-delivery-operations.ts';

/**
 * Which edge carried one leaf's frames to the other leaf while a layout was in force. A receiver acknowledges each
 * at-least-once copy to the peer it arrived from (`planAck`: `toPeerId: context.fromPeerId`), so its
 * `rtc-ack-submission` diagnostics name the hop: the origin itself is the direct edge, the relay the relayed path.
 * Only an acknowledged stream has those events; an unacknowledged frame's edge is `unobserved`.
 */
export interface LiveRtcCarryingEdges {
    readonly origin: AgentPrefix;
    readonly receiver: AgentPrefix;
    readonly layout: 'tree' | 'star';
    readonly frames: number;
    readonly direct: number;
    readonly relayed: number;
    /**
     * A frame acknowledged to both hops: two copies arrived, one over each edge, or a retry was routed over the other
     * hop and acknowledged again under the same trace.
     */
    readonly both: number;
    readonly unobserved: number;
    /**
     * First and last send time of the frames that arrived only directly, in ms after the origin promoted the layout,
     * on the origin's own page clock; `relayedSentMs` likewise for those that arrived only through the relay.
     */
    readonly directSentMs: readonly [number, number] | null;
    readonly relayedSentMs: readonly [number, number] | null;
    readonly bothSentMs: readonly [number, number] | null;
    /** Every frame acknowledged to the direct hop at all, `direct` and `both`, by its original send time. */
    readonly directOrBothSentMs: readonly [number, number] | null;
    /**
     * An observation: how long after the origin's promotion the first frame acknowledged to the direct hop was sent,
     * which shows whether the replaced edge was still open right after the promotion.
     */
    readonly firstDirectSentMs: number | null;
}

export interface LiveRtcCarryingEdgesInput {
    readonly origin: Readonly<{ prefix: AgentPrefix; sessionId: string; }>;
    readonly receiver: AgentPrefix;
    readonly relaySessionId: string;
    readonly layout: 'tree' | 'star';
    readonly promotedAtEpochMs: number;
    /** The origin's frames sent while it held this layout. */
    readonly frames: readonly Readonly<{ seq: number; startedAtEpochMs: number; }>[];
    /** The trace of the copy the receiver delivered, by sequence number. */
    readonly traceIdBySeq: ReadonlyMap<number, string>;
    /** The peers the receiver acknowledged each trace to. */
    readonly hopsByTraceId: ReadonlyMap<string, ReadonlySet<string>>;
}

type CarryingEdge = 'direct' | 'relayed' | 'both' | 'unobserved';

export function computeLiveRtcCarryingEdges(input: LiveRtcCarryingEdgesInput): LiveRtcCarryingEdges {
    const classified = input.frames.map((frame) => ({
        edge: resolveCarryingEdge(input, frame.seq),
        sentMs: frame.startedAtEpochMs - input.promotedAtEpochMs
    }));
    const count = (edge: CarryingEdge): number => classified.filter((frame) => frame.edge === edge).length;
    const directOrBothSentMs = toSentRange(
        classified.filter((frame) => frame.edge === 'direct' || frame.edge === 'both')
    );
    return {
        origin: input.origin.prefix,
        receiver: input.receiver,
        layout: input.layout,
        frames: classified.length,
        direct: count('direct'),
        relayed: count('relayed'),
        both: count('both'),
        unobserved: count('unobserved'),
        directSentMs: toSentRange(classified.filter((frame) => frame.edge === 'direct')),
        relayedSentMs: toSentRange(classified.filter((frame) => frame.edge === 'relayed')),
        bothSentMs: toSentRange(classified.filter((frame) => frame.edge === 'both')),
        directOrBothSentMs,
        firstDirectSentMs: directOrBothSentMs?.[0] ?? null
    };
}

function resolveCarryingEdge(input: LiveRtcCarryingEdgesInput, seq: number): CarryingEdge {
    const traceId = input.traceIdBySeq.get(seq);
    const hops = traceId === undefined ? undefined : input.hopsByTraceId.get(traceId);
    const direct = hops?.has(input.origin.sessionId) === true;
    const relayed = hops?.has(input.relaySessionId) === true;
    if (direct && relayed) {
        return 'both';
    }
    return direct ? 'direct' : relayed ? 'relayed' : 'unobserved';
}

function toSentRange(frames: readonly { sentMs: number; }[]): readonly [number, number] | null {
    const sent = frames.map((frame) => frame.sentMs);
    return sent.length === 0 ? null : [Math.min(...sent), Math.max(...sent)];
}
