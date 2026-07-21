import type { OverlayInfo, OverlayId } from './api-config.ts';
import type { GroupRef } from './group-types.ts';

export type RallarRtcTopologyKind = 'star' | 'tree' | 'mesh';

export type RallarOverlayTopologySnapshot = Readonly<{
    sourceGroupStateRevision: number;
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
    left: Pick<RallarOverlayTopologySnapshot, 'sourceGroupStateRevision' | 'version'>,
    right: Pick<RallarOverlayTopologySnapshot, 'sourceGroupStateRevision' | 'version'>,
): number {
    if (left.sourceGroupStateRevision !== right.sourceGroupStateRevision) {
        return left.sourceGroupStateRevision - right.sourceGroupStateRevision;
    }
    return left.version - right.version;
}

export function toOverlayInfoForSession(
    snapshot: RallarOverlayTopologySnapshot,
    sessionId: string,
): OverlayInfo {
    return {
        sourceGroupStateRevision: snapshot.sourceGroupStateRevision,
        provenance: 'topology-snapshot',
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
        updatedAtEpochMs: snapshot.updatedAtEpochMs,
    };
}
