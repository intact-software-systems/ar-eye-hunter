import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupTopologyConfigPatch, GroupTopologyConfigView } from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

import type { RtcTopologyKindHysteresisWidths } from '../runtime/rallar-rtc-topology-service.ts';
import type { GroupTopologyReplanningRead } from './resolve-topology-plan-action.ts';

export type GroupTopologyPlanningSnapshotSelection = 'prefer-current' | 'preserve-known-revision';

export interface ReadGroupTopologyPlanningAuthorityInput {
    readonly groupRef: GroupRef;
    readonly requestOptions?: GroupTopologyConfigPatch;
    readonly knownGroup?: GroupSnapshot;
    readonly snapshotSelection: GroupTopologyPlanningSnapshotSelection;
}

export interface GroupTopologyPlanningAuthority {
    readonly group: GroupSnapshot;
    readonly config: GroupTopologyConfigView;
    readonly kindHysteresisWidths: RtcTopologyKindHysteresisWidths;
    readonly rttReportingDegreeLimit: number;
    readonly rttMeasurements: readonly RttMeasurementInfo[];
    /**
     * The replanning mode the planning gate consults. Read from the stored
     * policy only for stages whose disposition follows it; every other
     * stage carries the default preset's mode, which its row never reads.
     */
    readonly replanning: GroupTopologyReplanningRead;
    readonly nowEpochMs: number;
}
