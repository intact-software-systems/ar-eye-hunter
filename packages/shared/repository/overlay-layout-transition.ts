import type { OverlayInfo } from '@shared/api/api-config.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';

export interface OverlayLayoutTransition {
    readonly replaced: OverlayInfo;
    readonly replacedBy: GroupLayoutIdentity;
    readonly replacedAtEpochMs: number;
}
