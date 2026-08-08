import type { GroupRef } from '@shared/api/group-types.ts';
// prettier-ignore
import type {
  CanonicalGroupTopologyConfigPatch,
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupTopologyConfigPatch } from '@shared/api/graph-topology-management-types.ts';

// prettier-ignore
import type {
  TopologyMutationAuthorityProof,
} from './topology-mutation-authority-proof.ts';

export type TopologyAppInboxOperation =
  | 'putConfig'
  | 'deleteConfig'
  | 'putOverride'
  | 'deleteOverride'
  | 'reconfigureTopology'
  | 'submitRtt';

type TopologyAppInboxRequestPayloadByOperation = Readonly<{
  putConfig: Readonly<{
    operation: 'putConfig';
    config: GroupTopologyConfigPatch;
  }>;
  deleteConfig: Readonly<{
    operation: 'deleteConfig';
    target: 'config';
  }>;
  putOverride: Readonly<{
    operation: 'putOverride';
    config: GroupTopologyConfigPatch;
    ttlMs: number | null;
    expiresAtEpochMs: number | null;
  }>;
  deleteOverride: Readonly<{
    operation: 'deleteOverride';
    target: 'override';
  }>;
  reconfigureTopology: Readonly<{
    operation: 'reconfigureTopology';
    requestOptions: GroupTopologyConfigPatch;
    publish: boolean;
  }>;
}>;

type TopologyAppInboxPayloadByOperation = Readonly<{
  putConfig: Readonly<{
    operation: 'putConfig';
    config: CanonicalGroupTopologyConfigPatch;
  }>;
  deleteConfig: Readonly<{
    operation: 'deleteConfig';
    target: 'config';
  }>;
  putOverride: Readonly<{
    operation: 'putOverride';
    config: CanonicalGroupTopologyConfigPatch;
    ttlMs: number | null;
    expiresAtEpochMs: number | null;
  }>;
  deleteOverride: Readonly<{
    operation: 'deleteOverride';
    target: 'override';
  }>;
  reconfigureTopology: Readonly<{
    operation: 'reconfigureTopology';
    requestOptions: CanonicalGroupTopologyConfigPatch;
    publish: boolean;
  }>;
}>;

type TopologyAppInboxCommandOperation = keyof TopologyAppInboxPayloadByOperation;

export type TopologyAppInboxRequestPayload<
  Operation extends TopologyAppInboxCommandOperation = TopologyAppInboxCommandOperation,
> = TopologyAppInboxRequestPayloadByOperation[Operation];

export type TopologyAppInboxPayload<
  Operation extends TopologyAppInboxCommandOperation = TopologyAppInboxCommandOperation,
> = TopologyAppInboxPayloadByOperation[Operation];

type TopologyAppInboxCommandFor<Operation extends TopologyAppInboxCommandOperation> = Readonly<{
  actor: Readonly<{
    principalId: string;
    sessionId: string;
  }>;
  groupRef: GroupRef;
  requestId: string;
  commandHash: string;
  capturedAtEpochMs: number;
  operation: Operation;
  payload: TopologyAppInboxPayload<Operation>;
}>;

export type TopologyAppInboxCommand = {
  [Operation in TopologyAppInboxCommandOperation]: TopologyAppInboxCommandFor<Operation>;
}[TopologyAppInboxCommandOperation];

type CreateTopologyAppInboxCommandInputFor<Operation extends TopologyAppInboxCommandOperation> =
  Readonly<{
    actor: TopologyAppInboxCommand['actor'];
    groupRef: GroupRef;
    requestId: string;
    capturedAtEpochMs: number;
    payload: TopologyAppInboxRequestPayload<Operation>;
  }>;

export type CreateTopologyAppInboxCommandInput<
  Operation extends TopologyAppInboxCommandOperation = TopologyAppInboxCommandOperation,
> = CreateTopologyAppInboxCommandInputFor<Operation>;

export type TopologyConfigAppInboxAuthority = Readonly<{
  kind: 'topology-config';
  proof: TopologyMutationAuthorityProof;
  command: TopologyAppInboxCommand;
}>;

export type TopologyReconfigureAppInboxAuthority = Readonly<{
  kind: 'topology-reconfigure';
  proof: TopologyMutationAuthorityProof;
  command: TopologyAppInboxCommand;
}>;

export type TopologyAppInboxAuthority =
  TopologyConfigAppInboxAuthority | TopologyReconfigureAppInboxAuthority;
