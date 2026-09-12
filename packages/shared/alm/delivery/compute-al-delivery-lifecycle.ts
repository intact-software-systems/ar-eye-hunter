import {
    isALDeliveryTerminal,
    type ALDeliveryAttempt,
    type ALDeliveryCarrier,
    type ALDeliveryEvidence,
    type ALDeliveryLifecycle,
    type ALDeliverySettlement,
    type ALDeliveryState
} from './al-delivery-lifecycle.ts';

type ALDeliveryAdmissionSettlement = Extract<ALDeliverySettlement, Readonly<{ kind: 'admission'; }>>;
type ALDeliveryAttemptStartedSettlement = Extract<ALDeliverySettlement, Readonly<{ kind: 'attempt-started'; }>>;
type ALDeliveryAttemptSettledSettlement = Extract<ALDeliverySettlement, Readonly<{ kind: 'attempt-settled'; }>>;
type ALDeliveryAcknowledgementSettlement = Extract<ALDeliverySettlement, Readonly<{ kind: 'acknowledgement'; }>>;

export function computeALDeliveryLifecycle(
    previous: ALDeliveryLifecycle,
    settlement: ALDeliverySettlement
): ALDeliveryLifecycle {
    if (isALDeliveryTerminal(previous)) {
        return toTerminalLifecycle(previous, settlement);
    }
    switch (settlement.kind) {
        case 'admission':
            return toAdmissionLifecycle(previous, settlement);
        case 'attempt-started':
        case 'attempt-settled':
            return toAttemptLifecycle(previous, settlement);
        case 'acknowledgement':
            return toAcknowledgementLifecycle(previous, settlement);
        case 'attempts-exhausted':
            return toReasonedLifecycle(previous, 'failed', settlement.detail);
        case 'expired':
            return toReasonedLifecycle(previous, 'expired', settlement.detail);
        case 'cancelled':
            return toReasonedLifecycle(previous, 'cancelled', 'Cancelled by the sender.');
    }
}

/** A settlement against an already-terminal lifecycle never reopens it; only evidence may still land. */
function toTerminalLifecycle(
    previous: ALDeliveryLifecycle,
    settlement: ALDeliverySettlement
): ALDeliveryLifecycle {
    const lateSettlementCount = previous.lateSettlementCount + 1;
    if (settlement.kind === 'attempt-settled') {
        return {
            ...previous,
            evidence: toSettledAttemptEvidence(previous.evidence, settlement),
            lateSettlementCount
        };
    }
    if (settlement.kind === 'acknowledgement') {
        return {
            ...previous,
            evidence: toAcknowledgementEvidence(previous.evidence, settlement),
            lateSettlementCount
        };
    }
    return { ...previous, lateSettlementCount };
}

function toAdmissionLifecycle(
    previous: ALDeliveryLifecycle,
    settlement: ALDeliveryAdmissionSettlement
): ALDeliveryLifecycle {
    const verdict = settlement.verdict;
    switch (verdict.kind) {
        case 'admitted':
            return toAdmittedLifecycle(
                previous,
                verdict.queuedAttempts > 0 ? 'queued' : 'accepted',
                settlement.atMs
            );
        case 'duplicate':
            return toAdmittedLifecycle(previous, 'accepted', settlement.atMs);
        case 'pending':
            return { ...previous };
        case 'deferred':
            return { ...previous, state: 'pending-authority' };
        case 'refused':
            return toReasonedLifecycle(previous, 'rejected', verdict.detail);
        case 'unroutable':
            return toUnroutableAdmissionLifecycle(previous, {
                carrier: settlement.carrier,
                atMs: settlement.atMs,
                detail: verdict.detail
            });
        case 'superseded':
        case 'expired':
        case 'failed':
            return toReasonedLifecycle(previous, verdict.kind, verdict.detail);
        case 'skipped':
            return toReasonedLifecycle(previous, 'failed', verdict.detail);
    }
}

function toAttemptLifecycle(
    previous: ALDeliveryLifecycle,
    settlement: ALDeliveryAttemptStartedSettlement | ALDeliveryAttemptSettledSettlement
): ALDeliveryLifecycle {
    return settlement.kind === 'attempt-started'
        ? toStartedAttemptLifecycle(previous, settlement)
        : toSettledAttemptLifecycle(previous, settlement);
}

function toAcknowledgementLifecycle(
    previous: ALDeliveryLifecycle,
    settlement: ALDeliveryAcknowledgementSettlement
): ALDeliveryLifecycle {
    const evidence = toAcknowledgementEvidence(previous.evidence, settlement);
    return settlement.complete ? { ...previous, state: 'acknowledged', evidence } : { ...previous, evidence };
}

function toReasonedLifecycle(
    previous: ALDeliveryLifecycle,
    state: ALDeliveryState,
    reason: string | undefined
): ALDeliveryLifecycle {
    return { ...previous, state, evidence: { ...previous.evidence, reason } };
}

function toAdmittedLifecycle(
    previous: ALDeliveryLifecycle,
    state: ALDeliveryState,
    atMs: number
): ALDeliveryLifecycle {
    return { ...previous, state, evidence: { ...previous.evidence, admittedAtMs: atMs } };
}

interface UnroutableAdmission {
    readonly carrier: ALDeliveryCarrier;
    readonly atMs: number;
    readonly detail: string;
}

/** The reducer's own synthetic attempt row for a carrier admission that never reached the transport. */
function toUnroutableAdmissionLifecycle(
    previous: ALDeliveryLifecycle,
    admission: UnroutableAdmission
): ALDeliveryLifecycle {
    const attempt: ALDeliveryAttempt = {
        attemptId: `admission:${admission.carrier}:${admission.atMs}`,
        carrier: admission.carrier,
        startedAtMs: admission.atMs,
        settledAtMs: admission.atMs,
        outcome: 'unroutable',
        submissionAttempted: false,
        detail: admission.detail
    };
    return {
        ...previous,
        evidence: { ...previous.evidence, attempts: [...previous.evidence.attempts, attempt] }
    };
}

function toStartedAttemptLifecycle(
    previous: ALDeliveryLifecycle,
    settlement: ALDeliveryAttemptStartedSettlement
): ALDeliveryLifecycle {
    if (previous.evidence.attempts.some((attempt) => attempt.attemptId === settlement.attemptId)) {
        return { ...previous };
    }
    const started: ALDeliveryAttempt = {
        attemptId: settlement.attemptId,
        carrier: settlement.carrier,
        startedAtMs: settlement.atMs,
        settledAtMs: undefined,
        outcome: undefined,
        submissionAttempted: false,
        detail: undefined
    };
    return {
        ...previous,
        evidence: { ...previous.evidence, attempts: [...previous.evidence.attempts, started] }
    };
}

function toSettledAttemptLifecycle(
    previous: ALDeliveryLifecycle,
    settlement: ALDeliveryAttemptSettledSettlement
): ALDeliveryLifecycle {
    const next: ALDeliveryLifecycle = {
        ...previous,
        evidence: toSettledAttemptEvidence(previous.evidence, settlement)
    };
    if (settlement.outcome === 'sent') {
        return { ...next, state: 'transport-accepted' };
    }
    if ((settlement.outcome === 'failed' || settlement.outcome === 'no-targets') && !settlement.willRetry) {
        return toReasonedLifecycle(next, 'failed', settlement.detail);
    }
    if (settlement.outcome === 'expired' || settlement.outcome === 'superseded') {
        return toReasonedLifecycle(next, settlement.outcome, settlement.detail);
    }
    return next;
}

function toSettledAttemptEvidence(
    evidence: ALDeliveryEvidence,
    settlement: ALDeliveryAttemptSettledSettlement
): ALDeliveryEvidence {
    const exists = evidence.attempts.some((attempt) => attempt.attemptId === settlement.attemptId);
    const attempts = exists
        ? evidence.attempts.map((attempt) =>
            attempt.attemptId === settlement.attemptId ? toSettledAttempt(attempt, settlement) : attempt
        )
        : [...evidence.attempts, toSettledAttempt(undefined, settlement)];
    return { ...evidence, attempts };
}

function toSettledAttempt(
    existing: ALDeliveryAttempt | undefined,
    settlement: ALDeliveryAttemptSettledSettlement
): ALDeliveryAttempt {
    return {
        attemptId: settlement.attemptId,
        carrier: settlement.carrier,
        startedAtMs: existing?.startedAtMs ?? settlement.atMs,
        settledAtMs: settlement.atMs,
        outcome: settlement.outcome,
        submissionAttempted: settlement.submissionAttempted,
        detail: settlement.detail
    };
}

function toAcknowledgementEvidence(
    evidence: ALDeliveryEvidence,
    settlement: ALDeliveryAcknowledgementSettlement
): ALDeliveryEvidence {
    return {
        ...evidence,
        confirmedHopPeerIds: [...settlement.confirmedHopPeerIds],
        unconfirmedHopPeerIds: [...settlement.unconfirmedHopPeerIds]
    };
}
