import type { GroupRef, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

export interface RtcTopologyPublication {
    readonly publicationId: string;
    readonly workId: string;
    readonly groupRef: GroupRef;
    readonly sourceGroupStateCausalRevision: GroupStateCausalRevision;
    readonly overlayVersion: number;
    readonly targetGroupSnapshotVersion: number;
    readonly recipientSessionIds: readonly string[];
    readonly snapshot: RallarOverlayTopologySnapshot;
    readonly expiresAtEpochMs: number;
    readonly createdAtEpochMs: number;
}
