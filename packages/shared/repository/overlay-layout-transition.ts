import type { OverlayInfo } from '@shared/api/api-config.ts';
import {
    isSameGroupLayoutIdentity,
    type GroupLayoutIdentity
} from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import { isRoomLayoutOverlay } from './is-accepted-room-layout-overlay.ts';

export interface OverlayLayoutTransition {
    readonly replaced: OverlayInfo;
    readonly replacedBy: GroupLayoutIdentity;
    readonly replacedAtEpochMs: number;
}

export function isLayoutTransitionReplacedBy(
    transition: OverlayLayoutTransition,
    roomRef: GroupRef,
    identity: GroupLayoutIdentity
): boolean {
    return isRoomLayoutOverlay(transition.replaced, roomRef) &&
        isSameGroupLayoutIdentity(transition.replacedBy, identity);
}

export function isLayoutTransitionInsideWindow(
    transition: OverlayLayoutTransition,
    nowMs: number,
    windowMs: number
): boolean {
    const elapsedMs = nowMs - transition.replacedAtEpochMs;
    return elapsedMs >= 0 && elapsedMs < windowMs;
}
