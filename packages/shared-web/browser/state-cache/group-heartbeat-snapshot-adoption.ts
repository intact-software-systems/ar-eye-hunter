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
            const renewed = isGroupHeartbeatSnapshotRenewal(observed, returned);
            const restoredSession = !renewed &&
                isGroupHeartbeatSessionReappearance(observed, returned);
            if (renewed || restoredSession) {
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
    if (!isTuplePreservingGroupLivenessReduction(returned, observed)) {
        return false;
    }

    let leaseAdvanced = false;
    for (const returnedSession of returned.activeSessions) {
        const observedSession = observed.activeSessions.find(
            (session) => session.sessionId === returnedSession.sessionId
        );
        if (
            !observedSession ||
            returnedSession.lastHeartbeatAtEpochMs < observedSession.lastHeartbeatAtEpochMs ||
            returnedSession.expiresAtEpochMs < observedSession.expiresAtEpochMs
        ) {
            return false;
        }
        leaseAdvanced ||= returnedSession.lastHeartbeatAtEpochMs > observedSession.lastHeartbeatAtEpochMs ||
            returnedSession.expiresAtEpochMs > observedSession.expiresAtEpochMs;
    }

    return returned.activeSessions.length === observed.activeSessions.length || leaseAdvanced;
}

function isGroupHeartbeatSessionReappearance(observed: GroupSnapshot, returned: GroupSnapshot): boolean {
    if (
        returned.activeSessions.length <= observed.activeSessions.length ||
        !isTuplePreservingGroupLivenessReduction(observed, returned)
    ) {
        return false;
    }
    return observed.activeSessions.every((previous) => {
        const current = returned.activeSessions.find((session) => session.sessionId === previous.sessionId);
        return current !== undefined &&
            current.lastHeartbeatAtEpochMs >= previous.lastHeartbeatAtEpochMs &&
            current.expiresAtEpochMs >= previous.expiresAtEpochMs;
    });
}
