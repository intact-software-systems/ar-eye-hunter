import type { GroupTopologyConfigPatch } from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

// prettier-ignore
import type * as persistence
  from '../../group-state/persistence/group-state-persistence-contracts.ts';
import type { ComputedRtcTopologyOutbox } from '../../services/rtc-topology-outbox-entry.ts';
// prettier-ignore
import type {
  GroupTopologyPlanningAuthority,
} from '../planning/group-topology-planning-authority.ts';

export interface GroupTopologyReconfigureCommand {
  readonly groupRef: GroupRef;
  readonly commandId: string;
  readonly actorPrincipalId: string;
  readonly capturedAtEpochMs: number;
  readonly requestOptions: GroupTopologyConfigPatch;
  readonly publish: boolean;
}

export interface GroupTopologyReconfigureRead {
  readonly authority: GroupTopologyPlanningAuthority;
  readonly authorityGuard: persistence.GroupStateAuthorityGuard;
}

export type GroupTopologyReconfigureComputed = ComputedRtcTopologyOutbox &
  Readonly<{ authorityGuard: persistence.GroupStateAuthorityGuard }>;
