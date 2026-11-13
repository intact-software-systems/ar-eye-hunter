import type { OverlayInfo } from '@shared/api/api-config.ts';
import {
    isSameGroupLayoutIdentity,
    type GroupLayoutIdentity
} from '@shared/api/group-lifecycle/group-layout-identity.ts';

export function toOverlayLayoutIdentity(overlay: OverlayInfo): GroupLayoutIdentity {
    return {
        groupRevision: overlay.sourceGroupStateCausalRevision.groupRevision,
        presenceRevision: overlay.sourceGroupStateCausalRevision.presenceRevision,
        version: overlay.overlayVersion,
        state: overlay.state
    };
}

export function isOverlayIdentity(
    overlay: OverlayInfo,
    identity: GroupLayoutIdentity
): boolean {
    return isSameGroupLayoutIdentity(
        toOverlayLayoutIdentity(overlay),
        identity
    );
}
