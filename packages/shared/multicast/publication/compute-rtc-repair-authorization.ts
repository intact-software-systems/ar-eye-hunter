import { resolveGroupPublicationPermissions } from '../../api/group-publication/group-publication-grants.ts';
import type { GroupSnapshot } from '../../api/group-types.ts';
import { Either } from '../../resilience/Either.ts';
import { resolveRoomObservationDenial } from '../rtc-room-snapshot-admission.ts';

export interface RtcRepairAuthorizationInput {
    /** The origin's cached snapshot of the message's room, read by its ref; `null` when it holds none. */
    readonly snapshot: GroupSnapshot | null;
    readonly selfPrincipalId: string;
    readonly topicId: string;
    readonly nowEpochMs: number;
}

/** A readable, live room whose snapshot no longer grants the origin's principal `publish`: the one terminal refusal. */
export interface RtcRepairRefusal {
    readonly kind: 'no-publish-grant';
}

/**
 * `authorized`: the origin still holds `publish`. `room-authority-decides`: no readable live snapshot attests the grant
 * either way, so the room-authority planning decides, as it does for any stored send (`not-yet-in-sync`, `NotReady`).
 */
export type RtcRepairAuthorization = 'authorized' | 'room-authority-decides';

/**
 * An origin re-sends a stored signed publication only while its current snapshot still grants its principal `publish`
 * (S3-R8): the proof attests the grant at signing, never after a revoke. Only a revoke its snapshot shows is terminal;
 * a missing or lapsed snapshot may yet be renewed.
 */
export function computeRtcRepairAuthorization(
    input: RtcRepairAuthorizationInput
): Either<RtcRepairRefusal, RtcRepairAuthorization> {
    const { snapshot } = input;
    if (snapshot === null || resolveRoomObservationDenial(snapshot.group, snapshot, input.nowEpochMs) !== undefined) {
        return Either.ofRight('room-authority-decides');
    }
    return resolveGroupPublicationPermissions(snapshot, input.selfPrincipalId, input.topicId).publish
        ? Either.ofRight('authorized')
        : Either.ofLeft({ kind: 'no-publish-grant' });
}
