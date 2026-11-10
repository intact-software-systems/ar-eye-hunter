import type { ALReceiptProofKeys } from '../../al-contracts/receipt-proof/al-receipt-proof.ts';
import { resolveALCountedRecipientPeerIds } from '../../alm/delivery/resolve-al-counted-recipient-peer-ids.ts';
import type { ALOutboundDispatchPlan } from '../../alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundTransportMessage } from '../../alm/outbound/al-outbound-transport-message.ts';
import { resolvePublicationKey } from '../../api/group-presence/resolve-publication-key.ts';
import type { GroupSnapshot } from '../../api/group-types.ts';

/** The room an origin plan reads its counted recipients' keys from, as its outbound observation reads it. */
export interface RtcReceiptProofRoom {
    readonly room: GroupSnapshot | undefined;
    readonly selfPeerId: string;
    readonly nowMs: number;
}

/** States the keys on an undropped plan of the origin's own logically receipted message; any other plan is returned as it is. */
export function toRtcReceiptProofDispatchPlan(
    plan: ALOutboundDispatchPlan<ALOutboundTransportMessage>,
    input: RtcReceiptProofRoom
): ALOutboundDispatchPlan<ALOutboundTransportMessage> {
    const counted = plan.ackTracking === undefined || plan.dropReasonCode !== undefined ||
            plan.msg.id.senderId !== input.selfPeerId
        ? undefined
        : resolveALCountedRecipientPeerIds(plan.msg, plan.ackTracking.mode);
    return counted === undefined ? plan : { ...plan, receiptProofKeys: toRtcReceiptProofKeys(counted, input) };
}

/** A counted recipient the room does not key is left out: the admission's key refusal already refused such a leg. */
function toRtcReceiptProofKeys(counted: readonly string[], input: RtcReceiptProofRoom): ALReceiptProofKeys {
    const { room, nowMs } = input;
    return Object.fromEntries(counted.flatMap((peerId) => {
        const key = room === undefined ? null : resolvePublicationKey(room, peerId, nowMs);
        return key === null ? [] : [[peerId, key] as const];
    }));
}
