import type { OverlayInfo } from '@shared/api/api-config.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RepositoryManager } from '@shared/cache/RepositoryManager.ts';

import { computeRecordedLayoutTransitions } from './compute-recorded-layout-transitions.ts';
import { isRoomLayoutOverlay } from './is-accepted-room-layout-overlay.ts';
import { isLayoutTransitionReplacedBy, type OverlayLayoutTransition } from './overlay-layout-transition.ts';
import { compareOverlayLayoutIdentity, toOverlayLayoutIdentity } from './to-overlay-layout-identity.ts';

export interface AcceptedLayoutChange {
    readonly overlayId: string;
    readonly held: OverlayInfo | undefined;
    /** The replaced layouts recorded while `held` was accepted, newest first. */
    readonly recorded: readonly OverlayLayoutTransition[];
    readonly taker: AcceptedLayoutTaker | null;
    readonly nowEpochMs: number;
    readonly manager?: RepositoryManager;
}

export interface AcceptedLayoutTaker {
    readonly roomRef: GroupRef;
    readonly identity: GroupLayoutIdentity;
}

/**
 * The history after the accepted slot changes, or `null` when it clears. A live layout of the room that dominates the
 * held one records its replacement. A taker of the empty slot keeps the history only when it is the layout the
 * newest entry, recorded when a group snapshot removed the held layout before this one arrived, names as its replacer.
 */
export function computeAcceptedLayoutTransitions(
    change: AcceptedLayoutChange
): readonly OverlayLayoutTransition[] | null {
    const { held, recorded, taker } = change;
    if (taker === null) {
        return null;
    }
    if (held === undefined) {
        const newest = recorded[0];
        return newest !== undefined && isLayoutTransitionReplacedBy(newest, taker.roomRef, taker.identity)
            ? recorded
            : null;
    }
    if (
        !isRoomLayoutOverlay(held, taker.roomRef) ||
        compareOverlayLayoutIdentity(taker.identity, toOverlayLayoutIdentity(held)) !== 'dominates'
    ) {
        return null;
    }
    return computeRecordedLayoutTransitions(recorded, {
        replaced: held,
        replacedBy: taker.identity,
        replacedAtEpochMs: change.nowEpochMs
    });
}
