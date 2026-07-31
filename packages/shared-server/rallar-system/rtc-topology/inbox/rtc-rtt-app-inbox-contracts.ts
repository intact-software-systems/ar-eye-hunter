import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import type { RtcRttRepository } from '../../repositories/RtcRttRepository.ts';
import type { TopologyMutationAuthorityProof } from '../../services/topology-mutation-authority-proof.ts';

export type RtcRttAppInboxCommand = Readonly<{
  actor: Readonly<{ principalId: string; sessionId: string }>;
  requestId: string;
  commandHash: string;
  mutationCommandHash: string;
  capturedAtEpochMs: number;
  rtt: RttMeasurementInfo;
}>;

export type RtcRttAppInboxAuthority = Readonly<{
  kind: 'rtc-rtt';
  proof: TopologyMutationAuthorityProof;
  command: RtcRttAppInboxCommand;
}>;

export type RtcRttAppInboxDependencies = Readonly<{
  repository: RtcRttRepository;
  readPolicyInputs(command: RtcRttAppInboxCommand): Promise<
    Readonly<{
      candidateGroups: readonly GroupSnapshot[];
      overlaySnapshotsByGroupKey: ReadonlyMap<string, RallarOverlayTopologySnapshot>;
      degreeLimit: number;
    }>
  >;
  observeCommitted?(rtt: RttMeasurementInfo): void;
}>;

export interface CreateRtcRttAppInboxEnqueueInput {
  readonly rtt: RttMeasurementInfo;
  readonly alSenderId: string;
  readonly capturedAtEpochMs: number;
}
