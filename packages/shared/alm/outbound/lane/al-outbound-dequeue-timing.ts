import type { ALWorkClaim } from '../../work/al-work-queue-port.ts';
import type { ALOutboundDequeuedAdmission } from './al-outbound-dequeued-admission.ts';

/** The optional timing sink cannot alter dequeue or release behavior. */
export function recordALOutboundDequeueTiming(
    sink: ALOutboundDequeuedAdmission.TimingSink | undefined,
    event: ALOutboundDequeuedAdmission.TimingEvent
): void {
    try {
        sink?.(event);
    }
    catch {
        // Optional timing must not affect the queue attempt.
    }
}

/** Claims are already reserved; these markers observe their return to the outbound work owner. */
export function recordALOutboundDequeueReservationReturns(
    input: Readonly<{
        claims: readonly ALWorkClaim[];
        dequeueTypes: ReadonlySet<string>;
        timing: ALOutboundDequeuedAdmission.TimingSink | undefined;
    }>
): void {
    if (input.timing === undefined) {
        return;
    }
    let batchIndex = 0;
    for (const claim of input.claims) {
        if (!input.dequeueTypes.has(claim.entry.typeId)) {
            continue;
        }
        recordALOutboundDequeueTiming(input.timing, {
            stage: 'reservation-return',
            key: claim.entry.key,
            attempts: claim.attempts,
            claimStartedAtEpochMs: claim.entry.dequeueAudit.startTs === undefined
                ? undefined
                : Number(claim.entry.dequeueAudit.startTs.epochMilliseconds),
            batchIndex
        });
        batchIndex += 1;
    }
}
