import type { ALMessage } from '../al-contracts/al-contract.ts';
import { resolveALOwnedChildPeerIds } from '../al-contracts/resolve-al-owned-child-peer-ids.ts';
import type { RtcOutboundCarrierAvailability } from './compute-rtc-outbound-carrier-availability.ts';
import { toALPreviousOverlayLayout } from './room-authority/to-al-previous-overlay-layout.ts';
import { toRtcOriginFrozenMessage } from './web-rtc-overlay-frozen-audience.ts';

export interface IsRtcOriginRouteUnavailableInput {
    readonly message: ALMessage;
    readonly availability: RtcOutboundCarrierAvailability;
    readonly selfPeerId: string;
    readonly readyPeerIds: readonly string[];
}

/**
 * This session's own send owns children, over the accepted layout and, in the first half of its overlap, a replaced
 * layout, and none of them is ready.
 */
export function isRtcOriginRouteUnavailable(input: IsRtcOriginRouteUnavailableInput): boolean {
    const { message, availability, selfPeerId } = input;
    if (
        message.id.senderId !== selfPeerId ||
        availability.kind !== 'available' || availability.admission.kind !== 'authorized' || !availability.context
    ) {
        return false;
    }
    const frozen = toRtcOriginFrozenMessage(message, availability.context, { selfPeerId, subscribeHolders: null });
    const ownedChildPeerIds = resolveALOwnedChildPeerIds(frozen, {
        nowMs: availability.context.nowMs,
        selfPeerId,
        groupMemberPeerIds: availability.admission.memberPeerIds,
        overlayNeighborPeerIds: availability.admission.forwardingPeerIds,
        overlayNextHopsBySessionId: availability.context.overlay.nextHopsBySessionId,
        previousOverlayLayout: toALPreviousOverlayLayout(availability.admission)
    });
    return ownedChildPeerIds.length > 0 &&
        ownedChildPeerIds.every((peerId) => !input.readyPeerIds.includes(peerId));
}
