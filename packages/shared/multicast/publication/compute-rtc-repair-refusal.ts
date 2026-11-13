import { resolveGroupPublicationPermissions } from '../../api/group-publication/group-publication-grants.ts';
import type { GroupSnapshot } from '../../api/group-types.ts';
import { resolveRoomObservationDenial } from '../room-authority/rtc-room-snapshot-admission.ts';

export interface RtcRepairRefusalInput {
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
 * An origin re-sends a stored signed publication only while its current snapshot still grants its principal `publish`
 * (S3-R8): the proof attests the grant at signing, never after a revoke. Only a revoke its snapshot shows is terminal;
 * a missing or lapsed snapshot may yet be renewed, so it passes to the room-authority planning, as any stored send
 * does (`not-yet-in-sync`, `NotReady`). `undefined`: the re-send passes.
 */
export function computeRtcRepairRefusal(input: RtcRepairRefusalInput): RtcRepairRefusal | undefined {
    const { snapshot } = input;
    if (snapshot === null || resolveRoomObservationDenial(snapshot.group, snapshot, input.nowEpochMs) !== undefined) {
        return undefined;
    }
    return resolveGroupPublicationPermissions(snapshot, input.selfPrincipalId, input.topicId).publish
        ? undefined
        : { kind: 'no-publish-grant' };
}
