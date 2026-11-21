import { toALGapRequestNumberField } from '../../../al-contracts/al-control-value-codec.ts';
import type { ALPeerRepairControlMessage } from '../../../al-contracts/al-control.ts';
import type { ALOutboundRepairHint } from '../admission/al-outbound-admission-store.ts';
import { isALOutboundRelayedGapNack } from './is-al-outbound-relayed-gap-nack.ts';

/**
 * The hint a peer's gap NACK or repair request raises. The gap is the hint's identity, so its payload
 * follows the gap too, never the control: `nack` names missing ranges, `repair` asks for the message
 * itself. The two controls a receiver sends for one gap thus build one hint, written once and absorbed
 * the second time rather than refused as conflicting content. A relay's gap NACK also names the
 * recipient it asks the repair for, which the responder admits the copy on and which names the hint
 * apart (S4ii-R3): each recipient a relay reports one gap for raises its own hint.
 */
export function toALOutboundControlRepairHint(
    control: ALPeerRepairControlMessage
): ALOutboundRepairHint {
    const { payload } = control;
    const missingRanges = payload.missingRanges ?? [];
    return {
        trigger: missingRanges.length > 0 ? 'nack' : 'repair',
        requestedByPeerId: payload.fromPeerId,
        ...(isALOutboundRelayedGapNack(control)
            ? { logicalRecipientPeerId: control.payload.logicalRecipientPeerId }
            : {}),
        orderingTrackKey: payload.orderingKey,
        missingRanges,
        ...(missingRanges.length > 0 ? toALGapRequestNumberField(payload.gapRequestNumber) : {}),
        failedPeerIds: []
    };
}
