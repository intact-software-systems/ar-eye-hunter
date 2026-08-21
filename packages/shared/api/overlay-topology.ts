import type { OverlayId, OverlayInfo } from './api-config.ts';
import { compareGroupCausalRevision, type GroupCausalRevisionOrder } from './group-client-views.ts';
import type { GroupRef, GroupStateCausalRevision } from './group-types.ts';

export type RallarRtcTopologyKind = 'star' | 'tree' | 'mesh';

export type RallarOverlayTopologySnapshot = Readonly<{
    sourceGroupStateCausalRevision: GroupStateCausalRevision;
    state: 'active' | 'removed';
    overlayId: OverlayId;
    groupRef: GroupRef;
    name: string;
    topology: RallarRtcTopologyKind;
    activeSessionIds: readonly string[];
    nextHopsBySessionId: Readonly<Record<string, readonly string[]>>;
    degreeLimit: number;
    version: number;
    createdByClientId: string;
    createdAtEpochMs: number;
    updatedAtEpochMs: number;
}>;

export function compareOverlayTopologyCausalTuple(
    left: Pick<RallarOverlayTopologySnapshot, 'sourceGroupStateCausalRevision' | 'version'>,
    right: Pick<RallarOverlayTopologySnapshot, 'sourceGroupStateCausalRevision' | 'version'>
): GroupCausalRevisionOrder {
    const sourceOrder = compareGroupCausalRevision(
        left.sourceGroupStateCausalRevision,
        right.sourceGroupStateCausalRevision
    );
    if (sourceOrder !== 'equal') {
        return sourceOrder;
    }
    if (left.version === right.version) {
        return 'equal';
    }
    return left.version > right.version ? 'dominates' : 'dominated';
}

export function toOverlayInfoForSession(
    snapshot: RallarOverlayTopologySnapshot,
    sessionId: string
): OverlayInfo {
    return {
        sourceGroupStateCausalRevision: snapshot.sourceGroupStateCausalRevision,
        provenance: 'server',
        state: snapshot.state,
        overlayId: snapshot.overlayId,
        groupRef: snapshot.groupRef,
        topology: snapshot.topology,
        name: snapshot.name,
        createdByClientId: snapshot.createdByClientId,
        createdAtEpochMs: snapshot.createdAtEpochMs,
        nextHopSessionIds: snapshot.nextHopsBySessionId[sessionId] ?? [],
        degreeLimit: snapshot.degreeLimit,
        overlayVersion: snapshot.version,
        updatedAtEpochMs: snapshot.updatedAtEpochMs
    };
}
