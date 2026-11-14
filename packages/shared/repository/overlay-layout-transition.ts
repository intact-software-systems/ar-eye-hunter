import type { OverlayInfo } from '@shared/api/api-config.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';

export interface OverlayLayoutTransition {
    readonly replaced: OverlayInfo;
    readonly replacedBy: GroupLayoutIdentity;
    readonly replacedAtEpochMs: number;
}

export function isLayoutTransitionInsideWindow(
    transition: OverlayLayoutTransition,
    nowMs: number,
    windowMs: number
): boolean {
    const elapsedMs = nowMs - transition.replacedAtEpochMs;
    return elapsedMs >= 0 && elapsedMs < windowMs;
}
