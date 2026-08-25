import { compareOverlayTopologyCausalTuple, type RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { RtcTopologySnapshotRevisionConflictError } from './rtc-topology-errors.ts';
import { rtcTopologySemanticEqual } from './rtc-topology-semantic-equal.ts';

export type RtcTopologySnapshotObservation =
    | 'inserted'
    | 'advanced'
    | 'duplicate'
    | 'stale'
    | 'incomparable';

export function decideTopologySnapshot(
    current: RallarOverlayTopologySnapshot | undefined,
    incoming: RallarOverlayTopologySnapshot
): RtcTopologySnapshotObservation {
    if (!current) {
        return 'inserted';
    }
    const tupleComparison = compareTopologyTuple(incoming, current);
    if (tupleComparison === 'dominates') {
        return 'advanced';
    }
    if (tupleComparison === 'dominated') {
        return 'stale';
    }
    if (tupleComparison === 'incomparable') {
        return 'incomparable';
    }
    if (rtcTopologySemanticEqual(current, incoming)) {
        return 'duplicate';
    }
    throw new RtcTopologySnapshotRevisionConflictError(incoming.groupRef);
}

export function compareTopologyTuple(
    left: Pick<RallarOverlayTopologySnapshot, 'sourceGroupStateCausalRevision' | 'version'>,
    right: Pick<RallarOverlayTopologySnapshot, 'sourceGroupStateCausalRevision' | 'version'>
): 'equal' | 'dominates' | 'dominated' | 'incomparable' {
    return compareOverlayTopologyCausalTuple(left, right);
}
