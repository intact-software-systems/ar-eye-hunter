import { isNotReadyException } from '../../../queuebox/resource-inbox/not-ready-exception.ts';
import type { ALDeliveryAdmissionVerdict } from '../../delivery/al-delivery-lifecycle.ts';
import type { ALWorkAttemptResult } from '../../work/al-work-handler.ts';
import type { ALWorkClaim } from '../../work/al-work-queue-port.ts';
import { recordALOutboundDequeueAttemptSettlement } from './al-outbound-dequeue-timing.ts';
import type { ALOutboundDequeuedAdmission } from './al-outbound-dequeued-admission.ts';
import type { ALOutboundReceiptWorkEvidence } from './al-outbound-receipt-observation.ts';

/** The evidence a claim's attempt publishes once it settles; a claim whose work never decoded has none. */
export interface ALOutboundClaimObservation {
    evidence: ALOutboundReceiptWorkEvidence | undefined;
    timing?: ALOutboundDequeuedAdmission.TimingSink;
    terminalReason?: string;
    verdict?: ALDeliveryAdmissionVerdict['kind'];
}

export interface ALOutboundClaimSettlement<TPrepared> {
    readonly attempt: Promise<ALWorkAttemptResult>;
    readonly observed: ALOutboundClaimObservation;
    readonly claim: ALWorkClaim;
    readonly batchIndex: number;
    readonly capture: ALOutboundReceiptWorkEvidence.Capture<TPrepared> | undefined;
    readonly readNowMs: () => number;
}

/** A claim keeps stage details only when it is a timed foreign outbox row. */
export function createALOutboundClaimObservation(
    claim: ALWorkClaim,
    timing: ALOutboundDequeuedAdmission.TimingSink | undefined,
    dequeueTypes: ReadonlySet<string>
): ALOutboundClaimObservation {
    const observed: ALOutboundClaimObservation = { evidence: undefined };
    if (timing !== undefined && dequeueTypes.has(claim.entry.typeId)) {
        observed.timing = timing;
    }
    return observed;
}

export function recordALOutboundClaimTerminalReason(
    observed: ALOutboundClaimObservation,
    reason: string
): void {
    if (observed.timing !== undefined) {
        observed.terminalReason = reason;
    }
}

/** Retains the already-computed admission decision for this claim's terminal marker. */
export function recordALOutboundClaimAdmissionVerdict(
    observed: ALOutboundClaimObservation,
    verdict: ALDeliveryAdmissionVerdict
): void {
    if (observed.timing !== undefined) {
        observed.verdict = verdict.kind;
        observed.terminalReason = 'reason' in verdict ? verdict.reason : undefined;
    }
}

export function createALOutboundClaimEvidence<TPrepared>(
    capture: ALOutboundReceiptWorkEvidence.Capture<TPrepared> | undefined,
    claim: ALOutboundReceiptWorkEvidence.Claim<TPrepared>
): ALOutboundReceiptWorkEvidence | undefined {
    try {
        return capture?.createEvidence(claim);
    }
    catch {
        // Optional evidence construction cannot change the claim's effects or release.
        return undefined;
    }
}

/** A claim's attempt as the work handler sees it, with its evidence published whatever it answered. */
export async function settleALOutboundClaim<TPrepared>(
    settlement: ALOutboundClaimSettlement<TPrepared>
): Promise<ALWorkAttemptResult> {
    const { capture, observed } = settlement;
    let result: ALWorkAttemptResult | undefined;
    try {
        result = await settlement.attempt;
        return result;
    }
    catch (error) {
        // A planner that is still waiting for authority owes no attempt: reschedule, never charge it.
        if (error instanceof Error && isNotReadyException(error)) {
            result = { status: 'not-ready', readyAtMs: settlement.readNowMs() + error.delayMs };
            return result;
        }
        throw error;
    }
    finally {
        try {
            if (capture !== undefined) {
                observed.evidence?.publish(capture.observer, result);
            }
        }
        finally {
            if (observed.timing !== undefined) {
                recordALOutboundDequeueAttemptSettlement({
                    timing: observed.timing,
                    claim: settlement.claim,
                    batchIndex: settlement.batchIndex,
                    outcome: result?.status ?? 'error',
                    verdict: observed.verdict,
                    reason: observed.terminalReason
                });
            }
        }
    }
}
