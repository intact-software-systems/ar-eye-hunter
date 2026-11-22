import { isRoomScopedALMessage, type ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALPeerRepairControlMessage } from '../../../al-contracts/al-control.ts';
import { resolveALFrozenMulticastAudience } from '../../../al-contracts/al-frozen-multicast-audience.ts';
import type {
    ALControlAdmissionRead,
    ALOutboundUnreceiptedRepairAudience
} from '../compute-al-outbound-control-admission.ts';

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

/**
 * A repair request, or a NACK other than one a relay re-sends, comes from a peer a repair may come from, or, when the
 * repair authority judged it, from one a send that tracks no receipt may be repaired for (6c).
 */
export function isALOutboundRepairRequester(
    read: ALControlAdmissionRead,
    control: ALPeerRepairControlMessage
): boolean {
    const requesterPeerId = control.payload.fromPeerId;
    return isALOutboundExpectedRepairPeer(read, requesterPeerId) ||
        (isALOutboundRepairAuthorityControl(control) && isALOutboundUnreceiptedRepairRecipient(read, requesterPeerId));
}

/** The controls the repair authority judges before their admission: a gap or not-yet-in-sync NACK, or a repair request. */
export function isALOutboundRepairAuthorityControl(control: ALPeerRepairControlMessage): boolean {
    return control.type === 'repair' ||
        (control.type === 'nack' && (control.payload.reason === 'gap' || control.payload.reason === 'not-yet-in-sync'));
}

/** A retained send that tracks no receipt and holds no receipt row, whose repair the frozen audience may ask for (6c). */
export function isALOutboundUnreceiptedSend(read: Pick<ALControlAdmissionRead, 'sent' | 'pending'>): boolean {
    return read.sent?.policy.ackTracking === null && read.pending === undefined;
}

/**
 * Who may ask for the repair of a retained send that tracks no receipt (6c); a unicast names its one recipient, whom
 * the expected-peer rule already admits.
 */
export function toALOutboundUnreceiptedRepairAudience(
    msg: ALMessage | undefined
): ALOutboundUnreceiptedRepairAudience | undefined {
    const frozen = resolveALFrozenMulticastAudience(msg?.targets);
    if (frozen !== undefined) {
        return { kind: 'frozen', recipientPeerIds: frozen.recipientPeerIds };
    }
    return msg !== undefined && isRoomScopedALMessage(msg) && msg.targets?.mode !== 'unicast'
        ? { kind: 'planned' }
        : undefined;
}

/**
 * A recipient a repair of a send that tracks no receipt may be asked for: one its frozen audience names, or, with none
 * frozen, any requester. That rests on `acceptControlMessage`, which admits a repair authority control only after
 * `readRepairAuthority` planned a repair to its sender, and a planned repair needs a ready room neighbour
 * (`planTargetedRepairDispatch`).
 */
export function isALOutboundUnreceiptedRepairRecipient(read: ALControlAdmissionRead, peerId: string): boolean {
    const audience = read.unreceiptedRepairAudience;
    return audience?.kind === 'planned' || audience?.recipientPeerIds.includes(peerId) === true;
}
