import type { ALMessagePlanningContext } from '../../al-contracts/al-policy.ts';
import type { OverlayInfo } from '../../api/api-config.ts';
import type { RtcRoomSnapshotAdmission } from './rtc-room-snapshot-admission.ts';

export function toALLayoutPlanningContext(
    admission: RtcRoomSnapshotAdmission,
    overlay: OverlayInfo | undefined
): Pick<
    ALMessagePlanningContext,
    'groupMemberPeerIds' | 'overlayNeighborPeerIds' | 'overlayNextHopsBySessionId' | 'previousOverlayLayout'
> {
    const authorized = admission.kind === 'authorized' ? admission : undefined;
    return {
        groupMemberPeerIds: authorized?.memberPeerIds ?? [],
        overlayNeighborPeerIds: authorized?.forwardingPeerIds ?? [],
        overlayNextHopsBySessionId: overlay?.nextHopsBySessionId,
        previousOverlayLayout: authorized?.previousForwarding ?? undefined
    };
}
