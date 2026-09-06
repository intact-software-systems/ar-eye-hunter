import type { OverlayInfo } from '@shared/api/api-config.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { Group, GroupRef } from '@shared/api/group-types.ts';
import { isOverlayIdentity } from '@shared/repository/overlays-repository.ts';

/**
 * A slot holds whatever the classifier last wrote under the overlay id; only a
 * live server publication for this room is a layout the room dials.
 */
export function isRoomLayoutOverlay(overlay: OverlayInfo | undefined, roomRef: GroupRef): overlay is OverlayInfo {
    return (
        overlay !== undefined &&
        overlay.provenance === 'server' &&
        overlay.state === 'active' &&
        isSameGroupRef(overlay.groupRef, roomRef)
    );
}

/** The accepted slot counts only while it holds the exact layout the group names as accepted. */
export function isAcceptedRoomLayoutOverlay(overlay: OverlayInfo | undefined, group: Group): overlay is OverlayInfo {
    return (
        isRoomLayoutOverlay(overlay, group) &&
        group.acceptedLayoutIdentity !== null &&
        isOverlayIdentity(overlay, group.acceptedLayoutIdentity)
    );
}
