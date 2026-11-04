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

/** Why an origin may not re-send its own stored signed publication: no live room authority, or no `publish` any more. */
export interface RtcRepairRefusal {
    readonly kind: 'no-authority' | 'no-publish-grant';
}

/**
 * An origin re-sends a stored signed publication only while its current snapshot still grants its principal `publish`
 * (S3-R8): the proof attests the grant at signing, never after a revoke.
 */
export function computeRtcRepairAuthorization(
    input: RtcRepairAuthorizationInput
): Either<RtcRepairRefusal, 'authorized'> {
    const { snapshot } = input;
    if (snapshot === null || resolveRoomObservationDenial(snapshot.group, snapshot, input.nowEpochMs) !== undefined) {
        return Either.ofLeft({ kind: 'no-authority' });
    }
    return resolveGroupPublicationPermissions(snapshot, input.selfPrincipalId, input.topicId).publish
        ? Either.ofRight('authorized')
        : Either.ofLeft({ kind: 'no-publish-grant' });
}
