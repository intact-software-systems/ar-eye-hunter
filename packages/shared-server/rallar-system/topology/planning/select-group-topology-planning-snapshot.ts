import { compareGroupCausalRevision, readGroupCausalRevision } from '@shared/api/group-client-views.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { isTuplePreservingGroupLivenessReduction } from '@shared/repository/group-state-snapshot-revision.ts';
import { GroupStateSnapshotIncomparableError } from '@shared/repository/group-state-snapshots-repository.ts';
import { StateSnapshotRevisionConflictError } from '@shared/repository/state-snapshot-revision.ts';

import { rtcTopologySemanticEqual } from '../persistence/rtc-topology-semantic-equal.ts';
import type { GroupTopologyPlanningSnapshotSelection } from './group-topology-planning-authority.ts';

export function isGroupTopologyActiveAt(
    snapshot: GroupSnapshot,
    observedAtEpochMs: number
): boolean {
    return (
        snapshot.group.status === 'active' &&
        (snapshot.group.expiresAtEpochMs === null ||
            snapshot.group.expiresAtEpochMs > observedAtEpochMs)
    );
}

/**
 * The formation window (Phase 5, M7): FORMING holds topology planning, so a
 * forming group has no planned overlay to establish and no dials to command.
 * Every other intent state plans -- RECONFIGURING exists precisely to redo
 * establishment work. Groups with immediate formation are created ACTIVE and
 * never enter FORMING, which keeps today's behaviour byte-identical for them.
 */
export function isGroupTopologyPlannableAt(
    snapshot: GroupSnapshot,
    observedAtEpochMs: number
): boolean {
    return (
        isGroupTopologyActiveAt(snapshot, observedAtEpochMs) &&
        snapshot.group.lifecycleState !== 'forming'
    );
}

export function selectGroupTopologyPlanningSnapshot(
    knownGroup: GroupSnapshot,
    currentGroup: GroupSnapshot | undefined,
    snapshotSelection: GroupTopologyPlanningSnapshotSelection
): GroupSnapshot {
    if (!currentGroup) {
        return knownGroup;
    }
    const comparison = compareGroupCausalRevision(
        readGroupCausalRevision(currentGroup),
        readGroupCausalRevision(knownGroup)
    );
    if (comparison === 'dominates') {
        return snapshotSelection === 'preserve-known-revision' ? knownGroup : currentGroup;
    }
    if (comparison === 'dominated') {
        return knownGroup;
    }
    if (comparison === 'incomparable') {
        throw new GroupStateSnapshotIncomparableError(knownGroup.group);
    }
    if (
        !rtcTopologySemanticEqual(currentGroup, knownGroup) &&
        !isTuplePreservingGroupLivenessReduction(currentGroup, knownGroup)
    ) {
        throw new StateSnapshotRevisionConflictError('Group', knownGroup.group.snapshotVersion);
    }
    return currentGroup;
}
