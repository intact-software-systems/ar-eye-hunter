import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import type { GroupFormationRttMutationSink } from '../../formation-metrics.ts';
import type { TopologyMutationAuthorityProof } from '../../topology/inbox/topology-mutation-authority-proof.ts';
import type { RtcRttRepository } from '../persistence/rtc-rtt-repository.ts';

export type RtcRttAppInboxCommand = Readonly<{
    actor: Readonly<{ principalId: string; sessionId: string; }>;
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
    formationMetrics?: GroupFormationRttMutationSink;
}>;

export interface CreateRtcRttAppInboxEnqueueInput {
    readonly rtt: RttMeasurementInfo;
    readonly alSenderId: string;
    readonly capturedAtEpochMs: number;
}
