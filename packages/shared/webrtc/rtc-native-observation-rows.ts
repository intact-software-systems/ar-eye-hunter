import type { FlushRtcIceCandidateQueueObservation } from './flush-rtc-ice-candidate-queue.ts';
import type { QRtcPeerConnection } from './qrtc-peer-connection.ts';
import type { RtcCandidateFragmentObservation } from './rtc-native-observation-values.ts';
import type { RtcSignalingDiagnostics } from './rtc-signaling-diagnostics.ts';

export interface RtcCandidateApplicationInput {
    readonly operation: QRtcPeerConnection.CandidateOperation;
    readonly observation: FlushRtcIceCandidateQueueObservation;
    readonly fragments: RtcCandidateFragmentObservation;
    readonly currentPeerConnection: boolean;
    readonly nativeSequence: number;
    readonly capture: RtcSignalingDiagnostics.CaptureStatus;
}

export function toRtcCandidateApplication(
    input: RtcCandidateApplicationInput
): RtcSignalingDiagnostics.CandidateApplication {
    const { operation, observation } = input;
    const coverage: RtcSignalingDiagnostics.OperationErrorCoverage = Object.freeze({
        kind: 'native-operation',
        stage: observation.stage === 'submitted' ? 'pending' : 'settled'
    });
    const error: RtcSignalingDiagnostics.ErrorReadout = observation.stage === 'rejected'
        ? Object.freeze({
            status: 'observed',
            value: Object.freeze({
                ...observation.error,
                source: 'candidate-rejection',
                identity: operation.binding.identity,
                nativeSequence: input.nativeSequence
            }),
            coverage
        })
        : observation.stage === 'returned'
        ? Object.freeze({ status: 'none-observed', coverage })
        : Object.freeze({ status: 'unavailable', reason: 'not-applicable', coverage });
    return Object.freeze({
        ...input.fragments,
        operationOrdinal: operation.operationOrdinal,
        applicationOrdinal: observation.index,
        source: operation.source,
        stage: observation.stage,
        currentPeerConnection: input.currentPeerConnection,
        identity: operation.binding.identity,
        targetTransportAssociation: 'unknown',
        iceGenerationAssociation: 'unknown',
        error,
        capture: input.capture
    });
}
