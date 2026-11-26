import { isNotReadyException } from '../../../queuebox/resource-inbox/not-ready-exception.ts';
import type { ALDeliveryAdmissionVerdict } from '../../delivery/al-delivery-lifecycle.ts';
import type { ALWorkAttemptResult, ALWorkClaimRun } from '../../work/al-work-handler.ts';
import type { ALWorkClaim } from '../../work/al-work-queue-port.ts';
import type { ALOutboundDurableEffect } from '../admission/al-outbound-admission-store.ts';
import type { ALOutboundDequeuedAdmission } from './al-outbound-dequeued-admission.ts';
import type { ALOutboundReceiptWorkEvidence } from './al-outbound-receipt-observation.ts';
import { recordALOutboundDequeueTiming } from './record-al-outbound-dequeue-timing.ts';

/** The evidence a claim's attempt publishes once it settles; a claim whose work never decoded has none. */
export interface ALOutboundClaimObservation {
    evidence: ALOutboundReceiptWorkEvidence | undefined;
    /** The effect the claimed row held, once its work decoded. */
    work: ALOutboundClaimWork | undefined;
    timing?: ALOutboundDequeuedAdmission.TimingSink;
    terminalReason?: string;
    verdict?: ALDeliveryAdmissionVerdict['kind'];
}

/** The effects an outbound work row holds; a kind does not depend on the type of the prepared copy a send carries. */
export type ALOutboundDurableEffectKind = ALOutboundDurableEffect<never>['kind'];

/** The effect a claimed outbound row held. */
export interface ALOutboundClaimWork {
    readonly effectId: string;
    readonly payloadKind: ALOutboundDurableEffectKind;
}

/**
 * One run of a claim of an outbound batch as its drain states it: the effect its row held, whether `expedite()` claimed
 * it and which of its runs this is, when the run started and what running it cost.
 */
export interface ALOutboundClaimRun extends ALOutboundClaimWork, ALWorkClaimRun {
    /** When its settlement began to be awaited: a claim of a group shares the group's start. */
    readonly startedAtMs: number;
    readonly durationMs: number;
}

/** What a claim answered the work handler, and its one run when its timing was wanted and its work decoded. */
export interface ALOutboundSettledClaim {
    readonly outcome: ALWorkAttemptResult;
    /** The claim's run, or none: a lane with no diagnostics sink takes none. */
    readonly runs: readonly ALOutboundClaimRun[];
}

/** The work attempt and physical claim identity handed from the lane or group to settlement. */
export interface ALOutboundClaimAttemptSettlement {
    readonly attempt: Promise<ALWorkAttemptResult>;
    readonly observed: ALOutboundClaimObservation;
    readonly claim: ALWorkClaim;
    readonly batchIndex: number;
}

export interface ALOutboundClaimSettlement<TPrepared> extends ALOutboundClaimAttemptSettlement {
    /** The run the work handler states the claim is in. */
    readonly claimRun: ALWorkClaimRun;
    readonly capture: ALOutboundReceiptWorkEvidence.Capture<TPrepared> | undefined;
    readonly readNowMs: () => number;
    /** Whether anyone reads the claim's run: without a diagnostics sink the clock is not read for it. */
    readonly timed: boolean;
}

/** A claim keeps stage details only when it is a timed foreign outbox row. */
export function createALOutboundClaimObservation(
    claim: ALWorkClaim,
    timing: ALOutboundDequeuedAdmission.TimingSink | undefined,
    dequeueTypes: ReadonlySet<string>
): ALOutboundClaimObservation {
    const observed: ALOutboundClaimObservation = { evidence: undefined, work: undefined };
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

/**
 * A claim runs from the moment its settlement is awaited: at once alone, and from the group's start in a group. A claim
 * that threw states no run.
 */
export async function settleALOutboundClaim<TPrepared>(
    settlement: ALOutboundClaimSettlement<TPrepared>
): Promise<ALOutboundSettledClaim> {
    const startedAtMs = settlement.timed ? settlement.readNowMs() : undefined;
    const outcome = await settleALOutboundAttempt(settlement);
    const { work } = settlement.observed;
    return {
        outcome,
        runs: startedAtMs === undefined || work === undefined
            ? []
            : [{
                ...work,
                ...settlement.claimRun,
                startedAtMs,
                durationMs: Math.max(0, settlement.readNowMs() - startedAtMs)
            }]
    };
}

/** A claim's attempt as the work handler sees it, with its evidence published whatever it answered. */
async function settleALOutboundAttempt<TPrepared>(
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
                recordALOutboundDequeueTiming(observed.timing, {
                    kind: 'attempt-settled',
                    settlement,
                    outcome: result?.status ?? 'error'
                });
            }
        }
    }
}
