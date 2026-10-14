import type { ALOutboundDispatchPlan } from './al-outbound-message-runtime.ts';

/**
 * Whether the peer is the sender's own hop: one of the next hops the captured plan sends through, or one
 * of the hops the composition sends every frame through (`hopPeerIds`: a WS client's server, which a send
 * that tracks no receipt still passes). A resend to it, or a repair it asks for, reaches the same hop with
 * the same prepared frame; that hop re-checks room authority at ingress and deduplicates the repeat, so
 * neither can widen a room audience.
 */
export function isALOutboundOwnHopPeer<TPrepared>(
    plan: ALOutboundDispatchPlan<TPrepared>,
    hopPeerIds: readonly string[] | undefined,
    peerId: string
): boolean {
    return (plan.ackTracking?.nextHopPeerIds ?? []).includes(peerId) || (hopPeerIds ?? []).includes(peerId);
}
