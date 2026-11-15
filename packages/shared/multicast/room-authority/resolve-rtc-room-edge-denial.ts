import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { OverlayInfo } from '../../api/api-config.ts';
import { isSameGroupRef } from '../../api/api-type-utils.ts';
import type { GroupRef } from '../../api/group-types.ts';
import type { RtcRoomAuthorityDenial } from './resolve-rtc-room-peer-denial.ts';
import type { RtcRoomRoutingEdges } from './resolve-rtc-room-routing-edges.ts';

/** Why a receiver answers a relayed copy as not yet in sync while the layout that names its relay is only planned. */
export const RTC_ROOM_LAYOUT_PROMOTION_AWAITED_REASON =
    'Awaiting the promotion of the planned layout that names the relay';

export interface RtcRoomEdgeObservation {
    readonly message: ALMessage;
    readonly overlay: OverlayInfo | undefined;
    readonly selfPeerId: string;
    readonly fromPeerId: string | undefined;
    readonly recipientPeerId: string | undefined;
}

export interface RtcRoomEdgeAuthority {
    readonly roomRef: GroupRef;
    readonly routingEdges: RtcRoomRoutingEdges;
}

/** The transport edge a room copy crossed, judged against the room's topology and the session's routing edges. */
export function resolveRtcRoomEdgeDenial(
    input: RtcRoomEdgeObservation,
    authority: RtcRoomEdgeAuthority
): RtcRoomAuthorityDenial | undefined {
    const nextHopPeerIds = input.message.forwarding?.nextHopPeerIds;
    if (
        input.fromPeerId !== undefined && nextHopPeerIds?.length &&
        (nextHopPeerIds.length !== 1 || nextHopPeerIds[0] !== input.selfPeerId)
    ) {
        return {
            kind: 'unauthorized',
            cause: 'authority-rejected',
            reason: 'RTC transport copy targets another immediate recipient'
        };
    }
    const overlay = input.overlay;
    if (overlay && (overlay.state === 'removed' || !isSameGroupRef(overlay.groupRef, authority.roomRef))) {
        return {
            kind: 'unauthorized',
            cause: 'authority-rejected',
            reason: 'RTC room topology is removed or belongs to another scope'
        };
    }
    return resolveRtcRoomLayoutEdgeDenial(input, authority);
}

function resolveRtcRoomLayoutEdgeDenial(
    input: RtcRoomEdgeObservation,
    authority: RtcRoomEdgeAuthority
): RtcRoomAuthorityDenial | undefined {
    const edgePeerId = input.recipientPeerId ??
        (input.fromPeerId !== input.message.id.senderId ? input.fromPeerId : undefined);
    if (edgePeerId === undefined) {
        return undefined;
    }
    const overlay = input.overlay;
    if (!overlay || overlay.provenance !== 'server') {
        return { kind: 'pending', reason: 'Awaiting server room relay authority' };
    }
    const { admittedEdgePeerIds, awaitedEdgePeerIds } = authority.routingEdges;
    if (admittedEdgePeerIds.includes(edgePeerId)) {
        return undefined;
    }
    return input.recipientPeerId === undefined && awaitedEdgePeerIds.includes(edgePeerId)
        ? { kind: 'pending', reason: RTC_ROOM_LAYOUT_PROMOTION_AWAITED_REASON }
        : {
            kind: 'unauthorized',
            cause: 'edge-unavailable',
            reason: 'RTC relay edge is not permitted by current server room topology'
        };
}
