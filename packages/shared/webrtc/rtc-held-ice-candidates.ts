import { retainNewest, type RetainNewestResult } from '../cache/retain-newest.ts';
import type { QRtcIceCandidateSignal } from './qrtc-signaling-contracts.ts';

export type RtcIceCandidateAdmission = 'apply' | 'hold' | 'supersede';

/** The held candidates once a remote description is applied, partitioned by what becomes of each. */
export interface RtcHeldIceCandidateRelease {
    readonly applied: readonly RTCIceCandidateInit[];
    readonly held: readonly QRtcIceCandidateSignal[];
    readonly superseded: readonly QRtcIceCandidateSignal[];
}

const MAX_HELD_RTC_ICE_CANDIDATES = 64;

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
