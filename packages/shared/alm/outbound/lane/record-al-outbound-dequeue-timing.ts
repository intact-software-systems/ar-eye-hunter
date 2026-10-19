import type { ALOutboundDequeuedAdmission } from './al-outbound-dequeued-admission.ts';

/** The optional timing sink cannot alter dequeue or release behavior. */
export function recordALOutboundDequeueTiming(
    sink: ALOutboundDequeuedAdmission.TimingSink | undefined,
    observation: ALOutboundDequeuedAdmission.TimingObservation
): void {
    try {
        sink?.(observation);
    }
    catch {
        // Optional timing must not affect the queue attempt.
    }
}
