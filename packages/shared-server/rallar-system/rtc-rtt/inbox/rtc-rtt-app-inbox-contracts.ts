import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import type { GroupFormationRttMutationSink } from '../../observability/formation-metrics.ts';
import type { TopologyMutationAuthorityProof } from '../../topology/inbox/topology-mutation-authority-proof.ts';
import type { RtcTopologyOutboxWriter } from '../../topology/mutation/rtc-topology-outbox-writer.ts';
import type { RtcRttRepository } from '../persistence/rtc-rtt-repository.ts';

export interface RtcRttAppInboxCommandActor {
    readonly principalId: string;
    readonly sessionId: string;
}

export interface RtcRttAppInboxCommand {
    readonly actor: RtcRttAppInboxCommandActor;
    readonly requestId: string;
    readonly commandHash: string;
    readonly mutationCommandHash: string;
    readonly capturedAtEpochMs: number;
    readonly rtt: RttMeasurementInfo;
}

export interface RtcRttAppInboxAuthority {
    readonly kind: 'rtc-rtt';
    readonly proof: TopologyMutationAuthorityProof;
    readonly command: RtcRttAppInboxCommand;
}

export interface RtcRttPolicyInputs {
    readonly candidateGroups: readonly GroupSnapshot[];
    readonly overlaySnapshotsByGroupKey: ReadonlyMap<string, RallarOverlayTopologySnapshot>;
    readonly degreeLimit: number;
}

export interface RtcRttAppInboxDependencies {
    readonly repository: RtcRttRepository;
    readonly outboxWriter: RtcTopologyOutboxWriter;
    readPolicyInputs(command: RtcRttAppInboxCommand): Promise<RtcRttPolicyInputs>;
    observeCommitted?(rtt: RttMeasurementInfo): void;
    formationMetrics?: GroupFormationRttMutationSink;
}

export interface CreateRtcRttAppInboxEnqueueInput {
    readonly rtt: RttMeasurementInfo;
    readonly alSenderId: string;
    readonly capturedAtEpochMs: number;
}
