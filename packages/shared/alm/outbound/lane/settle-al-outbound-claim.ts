import { isNotReadyException } from '../../../queuebox/resource-inbox/not-ready-exception.ts';
import type { ALWorkAttemptResult } from '../../work/al-work-handler.ts';
import type { ALOutboundReceiptWorkEvidence } from './al-outbound-receipt-observation.ts';

/** The evidence a claim's attempt publishes once it settles; a claim whose work never decoded has none. */
export interface ALOutboundClaimObservation {
    evidence: ALOutboundReceiptWorkEvidence | undefined;
}

export interface ALOutboundClaimSettlement<TPrepared> {
    readonly attempt: Promise<ALWorkAttemptResult>;
    readonly observed: ALOutboundClaimObservation;
    readonly capture: ALOutboundReceiptWorkEvidence.Capture<TPrepared> | undefined;
    readonly readNowMs: () => number;
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
        if (capture !== undefined) {
            observed.evidence?.publish(capture.observer, result);
        }
    }
}
