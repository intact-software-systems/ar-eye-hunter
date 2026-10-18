import type { ALWorkAttemptResult } from '../../work/al-work-handler.ts';
import type { ALWorkClaim } from '../../work/al-work-queue-port.ts';
import type { ALOutboundEffectSnapshot } from '../admission/al-outbound-admission-store.ts';
import type { ALOutboundDequeuedAdmission } from './al-outbound-dequeued-admission.ts';
import type { ALOutboundReceiptWorkEvidence } from './al-outbound-receipt-observation.ts';
import type { ALOutboundClaimObservation } from './settle-al-outbound-claim.ts';

export namespace ALOutboundDequeueClaimGroup {
    export interface Input<TPrepared> {
        /** The selection's dequeued rows, in claim order. */
        readonly claims: readonly ALWorkClaim[];
        /** What `runOutboundClaim` runs before a dequeued row's admission, here for every row at once. */
        readonly readWork: (claim: ALWorkClaim) => ALOutboundEffectSnapshot<TPrepared>;
        readonly timing: ALOutboundDequeuedAdmission.TimingSink | undefined;
        readonly hasReachedDeadline: (claim: ALWorkClaim) => boolean;
        readonly createEvidence: (
            work: ALOutboundEffectSnapshot<TPrepared>
        ) => ALOutboundReceiptWorkEvidence | undefined;
        readonly readSettledBeforeEffect: (
            work: ALOutboundEffectSnapshot<TPrepared>,
            observed: ALOutboundClaimObservation
        ) => ALWorkAttemptResult | undefined;
        readonly admit: (
            members: readonly ALOutboundDequeuedAdmission.Member<TPrepared>[]
        ) => readonly Promise<ALWorkAttemptResult>[];
        readonly settle: (
            attempt: Promise<ALWorkAttemptResult>,
            observed: ALOutboundClaimObservation,
            claim: ALWorkClaim,
            batchIndex: number
        ) => Promise<ALWorkAttemptResult>;
    }
}

/**
 * Starts every dequeued row of a selection at once and admits the ones still owed an admission together, so
 * the rows of one sender commit under one fence. A lone row is left to run alone: the group takes nothing.
 */
export function runALOutboundDequeueClaimGroup<TPrepared>(
    input: ALOutboundDequeueClaimGroup.Input<TPrepared>
): ReadonlyMap<ALWorkClaim, Promise<ALWorkAttemptResult>> {
    const attempts = new Map<ALWorkClaim, Promise<ALWorkAttemptResult>>();
    if (input.claims.length < 2) {
        return attempts;
    }
    const starts = input.claims.map((claim, index) => startDequeueClaim(input, claim, index));
    const admitted = input.admit(starts.flatMap((start) => start.kind === 'admit' ? [start.member] : []));
    let admittedIndex = 0;
    input.claims.forEach((claim, index) => {
        const start = starts[index]!;
        const attempt = start.kind === 'admit' ? admitted[admittedIndex++]! : start.attempt;
        attempts.set(claim, input.settle(attempt, start.observation, claim, index));
    });
    return attempts;
}

/** A dequeued row of a group: admitted with the group, or already settled before its admission. */
type ALOutboundDequeueStart<TPrepared> =
    | Readonly<{
        kind: 'admit';
        member: ALOutboundDequeuedAdmission.Member<TPrepared>;
        observation: ALOutboundClaimObservation;
    }>
    | Readonly<{
        kind: 'settled';
        observation: ALOutboundClaimObservation;
        attempt: Promise<ALWorkAttemptResult>;
    }>;

/** A row whose work cannot be read is dropped once its deadline passed, and rejected before. */
function startDequeueClaim<TPrepared>(
    input: ALOutboundDequeueClaimGroup.Input<TPrepared>,
    claim: ALWorkClaim,
    batchIndex: number
): ALOutboundDequeueStart<TPrepared> {
    const observation: ALOutboundClaimObservation = { evidence: undefined };
    if (input.timing !== undefined) {
        observation.timing = input.timing;
    }
    let work: ALOutboundEffectSnapshot<TPrepared>;
    try {
        work = input.readWork(claim);
    }
    catch (error) {
        const expired = input.hasReachedDeadline(claim);
        if (observation.timing !== undefined) {
            observation.terminalReason = expired ? 'expired' : 'decode-failed';
        }
        const attempt: Promise<ALWorkAttemptResult> = expired
            ? Promise.resolve({ status: 'completed' })
            : Promise.reject(error);
        return { kind: 'settled', observation, attempt };
    }
    observation.evidence = input.createEvidence(work);
    const member = {
        effect: work,
        evidence: observation.evidence,
        observation,
        batchIndex
    };
    const settled = input.readSettledBeforeEffect(work, observation);
    return settled === undefined
        ? { kind: 'admit', member, observation }
        : { kind: 'settled', observation, attempt: Promise.resolve(settled) };
}
