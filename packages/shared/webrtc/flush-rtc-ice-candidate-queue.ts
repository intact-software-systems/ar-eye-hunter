import { retainNewest, type RetainNewestResult } from '../cache/retain-newest.ts';
import { toError } from '../resilience/to-error.ts';
import type { QRtcIceCandidateSignal } from './qrtc-signaling-contracts.ts';
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

export type RtcIceCandidateAdmission = 'apply' | 'hold' | 'supersede';

/** The held candidates once a remote description is applied, partitioned by what becomes of each. */
export interface RtcHeldIceCandidateRelease {
    readonly applied: readonly RTCIceCandidateInit[];
    readonly held: readonly QRtcIceCandidateSignal[];
    readonly superseded: readonly QRtcIceCandidateSignal[];
}

const MAX_HELD_RTC_ICE_CANDIDATES = 64;

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

/**
 * A remote candidate belongs to the remote connection that gathered it, so it applies only to that connection's
 * description: one from a connection whose description has not arrived waits for it, and one from a connection older
 * than the newest applied remote generation can never apply.
 */
export function resolveRtcIceCandidateAdmission(
    candidateGeneration: number,
    appliedRemoteGeneration: number
): RtcIceCandidateAdmission {
    if (candidateGeneration > appliedRemoteGeneration) {
        return 'hold';
    }
    return candidateGeneration < appliedRemoteGeneration ? 'supersede' : 'apply';
}

export function resolveRtcHeldIceCandidateRelease(
    held: readonly QRtcIceCandidateSignal[],
    appliedRemoteGeneration: number
): RtcHeldIceCandidateRelease {
    const admitted = (admission: RtcIceCandidateAdmission) =>
        held.filter((signal) =>
            resolveRtcIceCandidateAdmission(signal.connectionGeneration, appliedRemoteGeneration) === admission
        );
    return {
        applied: admitted('apply').map((signal) => signal.payload.candidate),
        held: admitted('hold'),
        superseded: admitted('supersede')
    };
}

/** Adds a candidate to the held ones; past the bound the oldest are displaced. */
export function computeHeldRtcIceCandidates(
    held: readonly QRtcIceCandidateSignal[],
    signal: QRtcIceCandidateSignal
): RetainNewestResult<QRtcIceCandidateSignal> {
    return retainNewest([...held, signal], MAX_HELD_RTC_ICE_CANDIDATES);
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
