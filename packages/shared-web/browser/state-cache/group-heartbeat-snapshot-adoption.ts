import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { compareGroupCausalRevision } from '@shared/api/group-client-views.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import {
    decideGroupSnapshotCausalRevision,
    isTuplePreservingGroupLivenessReduction
} from '@shared/repository/group-state-snapshot-revision.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';

export function adoptGroupSnapshotsFromHeartbeat(
    observedBeforeHeartbeat: readonly GroupSnapshot[],
    returnedByHeartbeat: readonly GroupSnapshot[]
): void {
    for (const returned of returnedByHeartbeat) {
        const observed = observedBeforeHeartbeat.find((snapshot) => isSameGroupRef(snapshot.group, returned.group));
        if (!observed) {
            groupStateSnapshotsRepository.setGroupStateSnapshot(returned);
            continue;
        }

        if (
            compareGroupCausalRevision(
                returned.causalRevision,
                observed.causalRevision
            ) === 'equal'
        ) {
            decideGroupSnapshotCausalRevision(observed, returned);
            if (isGroupHeartbeatSnapshotRenewal(observed, returned)) {
                const replacement = Object.is(observed, returned)
                    ? { ...returned }
                    : returned;
                groupStateSnapshotsRepository.replaceGroupStateSnapshotIfUnchanged(
                    observed,
                    replacement
                );
            }
            continue;
        }

        groupStateSnapshotsRepository.setGroupStateSnapshot(returned);
    }
}

export function isGroupHeartbeatSnapshotRenewal(
    observed: GroupSnapshot,
    returned: GroupSnapshot
): boolean {
    if (
        observed.memberCount !== returned.memberCount ||
        observed.onlineMemberCount !== returned.onlineMemberCount ||
        observed.activeSessions.length !== returned.activeSessions.length ||
        !isTuplePreservingGroupLivenessReduction(returned, observed)
    ) {
        return false;
    }

    return observed.activeSessions.every((session, index) => {
        const returnedSession = returned.activeSessions[index];
        return returnedSession !== undefined &&
            returnedSession.sessionId === session.sessionId &&
            returnedSession.lastHeartbeatAtEpochMs >= session.lastHeartbeatAtEpochMs &&
            returnedSession.expiresAtEpochMs >= session.expiresAtEpochMs;
    });
}
