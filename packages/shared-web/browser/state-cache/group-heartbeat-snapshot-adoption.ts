import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { compareGroupCausalRevision } from '@shared/api/group-client-views.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import {
    isGroupSnapshotCausalRevisionCovered,
    isTuplePreservingGroupLivenessReduction
} from '@shared/repository/group-state-snapshot-revision.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';

import { emitBrowserStateReadDiagnostic } from '../state-read/diagnostics.ts';

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
            if (!isGroupSnapshotCausalRevisionCovered(observed, returned)) {
                adoptDivergentGroupSnapshot(observed, returned);
                continue;
            }
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

/**
 * The cache holds other content than the server at the same causal tuple, so it labels a revision with rows the
 * server never wrote there. The heartbeat's snapshot is the server's content at that tuple: it replaces a cached one
 * still live, without reviving one the cache TTL expired. The diagnostic reports the divergence observed, whether or
 * not a replacement happened.
 */
function adoptDivergentGroupSnapshot(observed: GroupSnapshot, returned: GroupSnapshot): void {
    if (groupStateSnapshotsRepository.findGroupStateSnapshotByRef(observed.group) !== undefined) {
        groupStateSnapshotsRepository.replaceGroupStateSnapshotIfUnchanged(observed, returned);
    }
    emitBrowserStateReadDiagnostic({
        name: 'rallar.browser.state-read',
        feature: 'group',
        operation: 'heartbeat',
        result: 'revision-conflict',
        durationMs: 0
    });
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
