import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type {
  GroupTopologyConfigPatch,
  StoredGroupTopologyConfig,
  StoredGroupTopologyOverride,
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef, GroupSnapshot, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';

import type { GroupStateRepository } from '../group-state/persistence/group-state-repository.ts';
// prettier-ignore
import type {
  GroupTopologyConfigRepository,
} from './config/persistence/group-topology-config-repository.ts';
import type { RtcRttRepository } from '../rtc-topology/persistence/rtc-rtt-repository.ts';
// prettier-ignore
import type {
  RtcTopologySnapshotRepository,
} from '../repositories/RtcTopologySnapshotRepository.ts';
import type { RallarRtcTopologyService } from '../services/rallar-rtc-topology-service.ts';
import type { RallarTimingSink } from '../services/timing.ts';
import type { GroupTopologyServerOptions } from './config/group-topology-config.ts';
// prettier-ignore
import type * as mutationContracts
  from './config/mutation/group-topology-config-mutation-contracts.ts';

export type GroupTopologyPublisher = (
  message: ALMessage,
  snapshot: RallarOverlayTopologySnapshot,
) => void | Promise<void>;

export type GroupTopologyGroupSnapshotReader = (
  ref: GroupRef,
  options?: Readonly<{
    minSnapshotVersion?: number;
    minCausalRevision?: GroupStateCausalRevision;
  }>,
) => GroupSnapshot | undefined | Promise<GroupSnapshot | undefined>;

export interface GroupTopologyManagementServiceOptions {
  readonly findGroupSnapshotByRef: GroupTopologyGroupSnapshotReader;
  readonly groupStateRepository?: GroupStateRepository;
  readonly configRepository?: GroupTopologyConfigRepository;
  readonly topologyService: RallarRtcTopologyService;
  readonly topologySnapshotRepository?: RtcTopologySnapshotRepository;
  readonly rttRepository?: RtcRttRepository;
  readonly processRttReader?: () => readonly RttMeasurementInfo[];
  readonly publisher?: GroupTopologyPublisher;
  readonly serverDefaults?: GroupTopologyServerOptions;
  readonly now?: () => number;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly timing?: RallarTimingSink;
  readonly serviceId?: string;
  readonly adminPrincipalIds?: ReadonlySet<string>;
}

export type ReconfigureGroupTopologyInput = Readonly<{
  groupRef: GroupRef;
  groupSnapshot?: GroupSnapshot;
  requestOptions?: GroupTopologyConfigPatch;
  publish?: boolean;
  publisher?: GroupTopologyPublisher;
}>;

export type PutGroupTopologyConfigInput = Readonly<{
  groupRef: GroupRef;
  config: GroupTopologyConfigPatch;
  updatedByPrincipalId: string;
  requestId?: string;
}>;

export type DeleteGroupTopologyConfigInput = Readonly<{
  groupRef: GroupRef;
  updatedByPrincipalId: string;
  requestId?: string;
}>;

export type PutGroupTopologyOverrideInput = PutGroupTopologyConfigInput &
  Readonly<{
    ttlMs?: number;
    expiresAtEpochMs?: number;
  }>;

export type PutGroupTopologyConfigResult = Readonly<{
  config: StoredGroupTopologyConfig;
  receipt: mutationContracts.GroupTopologyConfigMutationReceipt;
}>;

export type PutGroupTopologyOverrideResult = Readonly<{
  override: StoredGroupTopologyOverride;
  receipt: mutationContracts.GroupTopologyConfigMutationReceipt;
}>;

export type DeleteGroupTopologyConfigResult = Readonly<{
  deleted: boolean;
  receipt: mutationContracts.GroupTopologyConfigMutationReceipt;
}>;

export type ReconcileGroupTopologyResult = Readonly<{
  snapshot: RallarOverlayTopologySnapshot;
  previous: RallarOverlayTopologySnapshot | null;
  changed: boolean;
}>;
