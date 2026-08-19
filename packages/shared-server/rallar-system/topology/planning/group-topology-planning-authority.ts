import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type {
  GroupTopologyConfigPatch,
  GroupTopologyConfigView,
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

import type { RtcTopologyKindHysteresisWidths } from '../../services/rallar-rtc-topology-service.ts';

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
  readonly rttMeasurements: readonly RttMeasurementInfo[];
  readonly nowEpochMs: number;
}
