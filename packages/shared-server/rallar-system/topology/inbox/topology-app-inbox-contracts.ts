import type { GroupRef } from '@shared/api/group-types.ts';
import type { CanonicalGroupTopologyConfigPatch } from '@shared/api/graph-topology-management-types.ts';
import type { GroupTopologyConfigPatch } from '@shared/api/graph-topology-management-types.ts';

import type { TopologyMutationAuthorityProof } from '../../services/topology-mutation-authority-proof.ts';

export type TopologyAppInboxOperation =
  | 'putConfig'
  | 'deleteConfig'
  | 'putOverride'
  | 'deleteOverride'
  | 'reconfigureTopology'
  | 'submitRtt';

export type TopologyAppInboxRequestPayload =
  | Readonly<{
      operation: 'putConfig';
      config: GroupTopologyConfigPatch;
    }>
  | Readonly<{
      operation: 'deleteConfig';
      target: 'config';
    }>
  | Readonly<{
      operation: 'putOverride';
      config: GroupTopologyConfigPatch;
      ttlMs: number | null;
      expiresAtEpochMs: number | null;
    }>
  | Readonly<{
      operation: 'deleteOverride';
      target: 'override';
    }>
  | Readonly<{
      operation: 'reconfigureTopology';
      requestOptions: GroupTopologyConfigPatch;
      publish: boolean;
    }>;

export type TopologyAppInboxPayload =
  | Readonly<{
      operation: 'putConfig';
      config: CanonicalGroupTopologyConfigPatch;
    }>
  | Readonly<{
      operation: 'deleteConfig';
      target: 'config';
    }>
  | Readonly<{
      operation: 'putOverride';
      config: CanonicalGroupTopologyConfigPatch;
      ttlMs: number | null;
      expiresAtEpochMs: number | null;
    }>
  | Readonly<{
      operation: 'deleteOverride';
      target: 'override';
    }>
  | Readonly<{
      operation: 'reconfigureTopology';
      requestOptions: CanonicalGroupTopologyConfigPatch;
      publish: boolean;
    }>;

export type TopologyAppInboxCommand = Readonly<{
  actor: Readonly<{
    principalId: string;
    sessionId: string;
  }>;
  groupRef: GroupRef;
  requestId: string;
  commandHash: string;
  capturedAtEpochMs: number;
  operation: Exclude<TopologyAppInboxOperation, 'submitRtt'>;
  payload: TopologyAppInboxPayload;
}>;

export type CreateTopologyAppInboxCommandInput = Readonly<{
  actor: TopologyAppInboxCommand['actor'];
  groupRef: GroupRef;
  requestId: string;
  capturedAtEpochMs: number;
  payload: TopologyAppInboxRequestPayload;
}>;

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
