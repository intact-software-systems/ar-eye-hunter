import { toError } from '../resilience/to-error.ts';

export interface FlushRtcIceCandidateQueueInput {
    readonly queue: RTCIceCandidateInit[];
    readonly peerConnection: Pick<RTCPeerConnection, 'addIceCandidate'>;
    // Called once after each successful native addition, before the next candidate.
    // The owner reads its current counters here so a diagnostic reset during an
    // awaited addition does not redirect accounting into an obsolete snapshot.
    readonly onCandidateAdded: () => void;
}

export async function flushRtcIceCandidateQueue(input: FlushRtcIceCandidateQueueInput): Promise<void> {
    const queuedCandidates = input.queue.splice(0);
    for (const candidate of queuedCandidates) {
        try {
            await input.peerConnection.addIceCandidate(candidate);
        }
        catch (caught) {
            console.warn('Failed to add queued candidate:', toError(caught));
            continue;
        }
        input.onCandidateAdded();
    }
}
