import type { ALControlAdmissionRead } from '../compute-al-outbound-control-admission.ts';

/**
 * A repair or NACK comes from a unicast's addressee, from any peer its receipt expects, from a session a server
 * admitted the message to (D498: the server relays a browser-origin track to that audience, receipted or not), or
 * from a hop the composition sends every frame through: on WS, the server, tracked by the receipt or named by the
 * client.
 */
export function isALOutboundExpectedRepairPeer(read: ALControlAdmissionRead, peerId: string): boolean {
    return read.sent?.unicastPeerId === peerId || read.pending?.expectedPeerIds.includes(peerId) === true ||
        read.sent?.policy.admittedAudience?.includes(peerId) === true || read.hopPeerIds?.includes(peerId) === true;
}

/**
 * A control that speaks for a recipient other than its sender comes from a peer a repair may come from, or from a next
 * hop of the message, the relay that forwards it. A next hop is known only from a receipted send's tracking.
 */
export function isALOutboundRecipientControlSender(read: ALControlAdmissionRead, peerId: string): boolean {
    return isALOutboundExpectedRepairPeer(read, peerId) ||
        read.sent?.policy.ackTracking?.nextHopPeerIds.includes(peerId) === true;
}
