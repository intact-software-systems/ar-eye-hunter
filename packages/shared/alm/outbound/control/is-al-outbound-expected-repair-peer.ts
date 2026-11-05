import type { ALControlAdmissionRead } from '../compute-al-outbound-control-admission.ts';

/**
 * A repair or NACK comes from a unicast's addressee, from any peer its receipt expects, or from a hop the
 * composition sends every frame through: on WS, the server, tracked by the receipt or named by the client.
 */
export function isALOutboundExpectedRepairPeer(read: ALControlAdmissionRead, peerId: string): boolean {
    return read.sent?.unicastPeerId === peerId || read.pending?.expectedPeerIds.includes(peerId) === true ||
        read.hopPeerIds?.includes(peerId) === true;
}
