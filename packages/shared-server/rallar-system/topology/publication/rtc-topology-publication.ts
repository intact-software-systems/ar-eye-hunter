import type { GroupRef, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { RtcTopologyPlanRecord } from '@shared/api/topology-plan/rtc-topology-plan-record.ts';

export interface RtcTopologyPublication {
    readonly publicationId: string;
    readonly workId: string;
    readonly groupRef: GroupRef;
    readonly sourceGroupStateCausalRevision: GroupStateCausalRevision;
    readonly overlayVersion: number;
    readonly targetGroupSnapshotVersion: number;
    readonly recipientSessionIds: readonly string[];
    readonly snapshot: RallarOverlayTopologySnapshot;
    /** Null exactly when `snapshot` is a removed tombstone: a removal plans no layout. */
    readonly plan: RtcTopologyPlanRecord | null;
    readonly expiresAtEpochMs: number;
    readonly createdAtEpochMs: number;
    readonly traceId: string;
}
