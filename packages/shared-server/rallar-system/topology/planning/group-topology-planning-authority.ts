import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupTopologyConfigView } from '@shared/api/graph-topology-management-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

export interface GroupTopologyPlanningAuthority {
  readonly group: GroupSnapshot;
  readonly config: GroupTopologyConfigView;
  readonly rttMeasurements: readonly RttMeasurementInfo[];
  readonly nowEpochMs: number;
}
