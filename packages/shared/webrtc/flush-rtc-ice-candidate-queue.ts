import { toError } from '../resilience/to-error.ts';
import { readRtcNativeErrorFacts, toRtcUnavailableErrorFacts } from './rtc-native-observation-values.ts';
import type { RtcSignalingDiagnostics } from './rtc-signaling-diagnostics.ts';

export type FlushRtcIceCandidateQueueObservation =
    | { readonly candidate: RTCIceCandidateInit; readonly index: number; readonly stage: 'submitted' | 'returned'; }
    | {
        readonly candidate: RTCIceCandidateInit;
        readonly index: number;
        readonly stage: 'rejected';
        readonly error: RtcSignalingDiagnostics.NativeErrorFacts;
    };

export interface FlushRtcIceCandidateQueueInput {
    readonly readCandidateError?: (caught: unknown) => RtcSignalingDiagnostics.NativeErrorFacts;
    readonly onCandidateObservation?: (observation: FlushRtcIceCandidateQueueObservation) => void;
    readonly queue: RTCIceCandidateInit[];
    readonly peerConnection: Pick<RTCPeerConnection, 'addIceCandidate'>;
    // Called once after each successful native addition, before the next candidate.
    // The owner reads its current counters here so a diagnostic reset during an
    // awaited addition does not redirect accounting into an obsolete snapshot.
    readonly onCandidateAdded: () => void;
}

export async function flushRtcIceCandidateQueue(input: FlushRtcIceCandidateQueueInput): Promise<void> {
    const queuedCandidates = input.queue.splice(0);
    for (const [index, candidate] of queuedCandidates.entries()) {
        let submitted = false;
        try {
            const addition = input.peerConnection.addIceCandidate(candidate);
            submitted = true;
            publishCandidateObservation(input, { candidate, index, stage: 'submitted' });
            await addition;
        }
        catch (caught) {
            if (input.onCandidateObservation) {
                if (!submitted) {
                    publishCandidateObservation(input, { candidate, index, stage: 'submitted' });
                }
                publishCandidateObservation(input, {
                    candidate,
                    index,
                    stage: 'rejected',
                    error: readCandidateError(input, caught)
                });
            }
            console.warn('Failed to add queued candidate:', toError(caught));
            continue;
        }
        input.onCandidateAdded();
        publishCandidateObservation(input, { candidate, index, stage: 'returned' });
    }
}

function publishCandidateObservation(
    input: FlushRtcIceCandidateQueueInput,
    observation: FlushRtcIceCandidateQueueObservation
): void {
    try {
        input.onCandidateObservation?.(observation);
    }
    catch { /* Observation failure cannot alter the FIFO drain or its successful count. */ }
}

function readCandidateError(
    input: FlushRtcIceCandidateQueueInput,
    caught: unknown
): RtcSignalingDiagnostics.NativeErrorFacts {
    try {
        return (input.readCandidateError ?? readRtcNativeErrorFacts)(caught);
    }
    catch {
        return toRtcUnavailableErrorFacts();
    }
}
