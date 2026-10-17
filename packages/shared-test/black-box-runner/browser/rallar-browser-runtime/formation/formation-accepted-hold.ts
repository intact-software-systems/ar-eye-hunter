import type {
    RallarRoomFormationStatus
} from '@shared-web/browser/rooms/formation/rallar-room-formation-contracts.ts';
import { toScopedRoomKey } from '@shared/api/api-type-utils.ts';
import {
    isSameGroupLayoutIdentity,
    type GroupLayoutIdentity
} from '@shared/api/group-lifecycle/group-layout-identity.ts';

interface HeldAcceptedLayout {
    readonly identity: GroupLayoutIdentity;
    readonly groupRevision: number;
    readonly sinceEpochMs: number;
}

/**
 * When this page first held each room's accepted layout at the room's current group revision, on the page's own
 * clock. A status observed later than its arrival only makes the hold start later, never earlier.
 */
export class FormationAcceptedHold {
    readonly #held = new Map<string, HeldAcceptedLayout>();

    /** Answers since when the status's accepted layout has been held at its revision; undefined when none is. */
    observe(status: RallarRoomFormationStatus, atEpochMs: number): number | undefined {
        const key = toScopedRoomKey(status.roomRef);
        const accepted = status.accepted;
        if (accepted === undefined) {
            this.#held.delete(key);
            return undefined;
        }
        const groupRevision = status.snapshot.causalRevision.groupRevision;
        const held = this.#held.get(key);
        if (
            held !== undefined &&
            held.groupRevision === groupRevision &&
            isSameGroupLayoutIdentity(held.identity, accepted.identity)
        ) {
            return held.sinceEpochMs;
        }
        this.#held.set(key, { identity: accepted.identity, groupRevision, sinceEpochMs: atEpochMs });
        return atEpochMs;
    }
}
