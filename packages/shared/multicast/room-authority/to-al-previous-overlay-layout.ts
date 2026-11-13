import type { ALPreviousOverlayLayout } from '../../al-contracts/resolve-al-owned-child-peer-ids.ts';
import type { RtcRoomSnapshotAdmission } from './rtc-room-snapshot-admission.ts';

/** The replaced layout an authorized room admission also forwards over, as the AL planner reads it. */
export function toALPreviousOverlayLayout(admission: RtcRoomSnapshotAdmission): ALPreviousOverlayLayout | undefined {
    if (admission.kind !== 'authorized' || admission.previousForwarding === null) {
        return undefined;
    }
    return {
        neighborPeerIds: admission.previousForwarding.neighbourPeerIds,
        nextHopsBySessionId: admission.previousForwarding.nextHopsBySessionId
    };
}
