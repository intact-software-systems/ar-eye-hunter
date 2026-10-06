import type { ALOutboundDispatchPlan } from './al-outbound-message-runtime.ts';

/**
 * Whether the peer is one of the next hops the captured plan sends through: the sender's own hop. A
 * resend to it, or a repair it asks for, reaches the same hop with the same prepared frame; that hop
 * re-checks room authority at ingress and deduplicates the repeat, so neither can widen a room audience.
 */
export function isALOutboundOwnHopPeer<TPrepared>(
    plan: ALOutboundDispatchPlan<TPrepared>,
    peerId: string
): boolean {
    return (plan.ackTracking?.nextHopPeerIds ?? []).includes(peerId);
}
