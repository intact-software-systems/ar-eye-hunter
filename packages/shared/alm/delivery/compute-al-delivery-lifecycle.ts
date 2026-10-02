import type { ALAckAlgo } from '../../al-contracts/al-policy.ts';
import type { ALDeliveryFailure } from './al-delivery-failure.ts';
import {
    isALDeliveryTerminal,
    type ALDeliveryAdmissionVerdict,
    type ALDeliveryAttempt,
    type ALDeliveryCarrier,
    type ALDeliveryEvidence,
    type ALDeliveryLifecycle,
    type ALDeliveryReceiptDowngrade,
    type ALDeliveryRefusalReason,
    type ALDeliverySettlement,
    type ALDeliveryState,
    type ALDeliveryUnroutableReason
} from './al-delivery-lifecycle.ts';

type ALDeliveryAdmissionSettlement = Extract<ALDeliverySettlement, Readonly<{ kind: 'admission'; }>>;
type ALDeliveryAttemptStartedSettlement = Extract<ALDeliverySettlement, Readonly<{ kind: 'attempt-started'; }>>;
type ALDeliveryAttemptSettledSettlement = Extract<ALDeliverySettlement, Readonly<{ kind: 'attempt-settled'; }>>;
type ALDeliveryAcknowledgementSettlement = Extract<ALDeliverySettlement, Readonly<{ kind: 'acknowledgement'; }>>;
type ALDeliveryRelayRejectedSettlement = Extract<ALDeliverySettlement, Readonly<{ kind: 'relay-rejected'; }>>;
type ALDeliveryReceiptExhaustedSettlement = Extract<ALDeliverySettlement, Readonly<{ kind: 'receipt-exhausted'; }>>;
type ALDeliveryCarrierFallbackSettlement = Extract<ALDeliverySettlement, Readonly<{ kind: 'carrier-fallback'; }>>;
type ALDeliveryDurabilityDowngradeSettlement = Extract<
    ALDeliverySettlement,
    Readonly<{ kind: 'durability-downgrade'; }>
>;

export function computeALDeliveryLifecycle(
    previous: ALDeliveryLifecycle,
    settlement: ALDeliverySettlement
): ALDeliveryLifecycle {
    if (isLeftCarrierReceipt(previous, settlement)) {
        return { ...previous };
    }
    if (isALDeliveryTerminal(previous)) {
        return toTerminalLifecycle(previous, settlement);
    }
    switch (settlement.kind) {
        case 'admission':
            return toAdmissionLifecycle(previous, settlement);
        case 'carrier-refused':
            return toAdmissionAttemptLifecycle(previous, {
                outcome: 'refused',
                carrier: settlement.carrier,
                atMs: settlement.atMs,
                detail: settlement.detail,
                reason: settlement.reason
            });
        case 'carrier-fallback':
            return toCarrierFallbackLifecycle(previous, settlement);
        case 'durability-downgrade':
            return toDurabilityDowngradeLifecycle(previous, settlement);
        case 'attempt-started':
        case 'attempt-settled':
            return toAttemptLifecycle(previous, settlement);
        case 'acknowledgement':
            return toAcknowledgementLifecycle(previous, settlement);
        case 'relay-rejected':
            return toRelayRejectedLifecycle(previous, settlement);
        case 'receipt-exhausted':
            return toReceiptExhaustedLifecycle(previous, settlement);
        case 'not-yet-in-sync-exhausted':
            return { ...previous };
        case 'attempts-exhausted':
            return toFailureLifecycle(previous, { kind: 'unroutable', reason: settlement.reason }, settlement.detail);
        case 'expired':
            return toFailureLifecycle(previous, { kind: 'expired' }, settlement.detail);
        case 'superseded':
            return toReasonedLifecycle(previous, 'superseded', settlement.detail);
        case 'cancelled':
            return toReasonedLifecycle(previous, 'cancelled', 'Cancelled by the sender.');
    }
}

/**
 * The message deadline has no settlement of its own: no carrier owner emits it, so every observer
 * applies it when it reads.
 */
export function computeALDeliveryDeadline(
    lifecycle: ALDeliveryLifecycle,
    nowMs: number
): ALDeliveryLifecycle {
    if (isALDeliveryTerminal(lifecycle) || lifecycle.expiresAtMs === undefined || nowMs < lifecycle.expiresAtMs) {
        return lifecycle;
    }
    return toFailureLifecycle(
        lifecycle,
        { kind: 'expired' },
        'The deadline elapsed before a terminal settlement.'
    );
}

/** The end an observer states for itself when it stops following a message that never settled. */
export function computeALDeliveryUnobservable(lifecycle: ALDeliveryLifecycle): ALDeliveryLifecycle {
    if (isALDeliveryTerminal(lifecycle)) {
        return lifecycle;
    }
    return toReasonedLifecycle(lifecycle, 'unobservable', 'The observation was lost before a terminal settlement.');
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
    if (settlement.kind === 'relay-rejected') {
        return {
            ...previous,
            evidence: { ...previous.evidence, relayRejection: settlement.relayRejection },
            lateSettlementCount
        };
    }
    if (settlement.kind === 'admission') {
        return { ...toLateAdmissionLifecycle(previous, settlement), lateSettlementCount };
    }
    return { ...previous, lateSettlementCount };
}

/**
 * A late admission on a terminal handle lands its evidence and never changes terminality: the tracked
 * receipt applies only where the handle stays terminal under it.
 */
function toLateAdmissionLifecycle(
    previous: ALDeliveryLifecycle,
    settlement: ALDeliveryAdmissionSettlement
): ALDeliveryLifecycle {
    const verdict = settlement.verdict;
    if (verdict.kind !== 'admitted' && verdict.kind !== 'duplicate') {
        return previous;
    }
    const admitted = {
        ...toAdmittedLifecycle(previous, toAdmittedAdmission(previous, settlement, verdict)),
        state: previous.state
    };
    return isALDeliveryTerminal(admitted) ? admitted : { ...admitted, receiptAlgo: previous.receiptAlgo };
}

function toAdmissionLifecycle(
    previous: ALDeliveryLifecycle,
    settlement: ALDeliveryAdmissionSettlement
): ALDeliveryLifecycle {
    const verdict = settlement.verdict;
    switch (verdict.kind) {
        case 'admitted':
        case 'duplicate':
            return toAdmittedLifecycle(previous, toAdmittedAdmission(previous, settlement, verdict));
        case 'pending':
            return { ...previous };
        case 'deferred':
            return { ...previous, state: 'pending-authority' };
        case 'refused':
            return toFailureLifecycle(previous, { kind: 'refused', reason: verdict.reason }, verdict.detail);
        case 'unroutable':
            return toAdmissionAttemptLifecycle(previous, {
                outcome: 'unroutable',
                carrier: settlement.carrier,
                atMs: settlement.atMs,
                detail: verdict.detail,
                reason: verdict.reason
            });
        case 'superseded':
            return toReasonedLifecycle(previous, 'superseded', verdict.detail);
        case 'expired':
            return toFailureLifecycle(previous, { kind: 'expired' }, verdict.detail);
        case 'failed':
            return toFailureLifecycle(previous, { kind: 'admission-failed' }, verdict.detail);
        case 'storage-unavailable':
            return toFailureLifecycle(previous, { kind: 'storage-unavailable', cause: verdict.cause }, verdict.detail);
        case 'skipped':
            return toFailureLifecycle(previous, { kind: 'skipped', reason: verdict.reason }, verdict.detail);
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
    return isAcknowledged(settlement) ? { ...previous, state: 'acknowledged', evidence } : { ...previous, evidence };
}

/** Under `receiver` only logical completeness acknowledges: every expected recipient confirmed. */
function isAcknowledged(settlement: ALDeliveryAcknowledgementSettlement): boolean {
    return settlement.mode === 'receiver'
        ? settlement.complete && settlement.unconfirmedRecipientPeerIds.length === 0
        : settlement.complete;
}

function toRelayRejectedLifecycle(
    previous: ALDeliveryLifecycle,
    settlement: ALDeliveryRelayRejectedSettlement
): ALDeliveryLifecycle {
    const rejection = settlement.relayRejection;
    const rejected = toFailureLifecycle(
        previous,
        { kind: 'relay-rejected', rejection },
        settlement.detail
    );
    return { ...rejected, evidence: { ...rejected.evidence, relayRejection: rejection } };
}

/** The receipt ended unconfirmed: terminal `failed`, and the peers it did confirm stay in evidence. */
function toReceiptExhaustedLifecycle(
    previous: ALDeliveryLifecycle,
    settlement: ALDeliveryReceiptExhaustedSettlement
): ALDeliveryLifecycle {
    const failed = toFailureLifecycle(previous, toReceiptExhaustedFailure(settlement), settlement.detail);
    const hopReceipt = settlement.mode !== 'receiver';
    return {
        ...failed,
        evidence: {
            ...failed.evidence,
            receiptMode: settlement.mode,
            confirmedHopPeerIds: hopReceipt
                ? [...settlement.confirmedPeerIds]
                : failed.evidence.confirmedHopPeerIds,
            unconfirmedHopPeerIds: hopReceipt
                ? [...settlement.unconfirmedPeerIds]
                : failed.evidence.unconfirmedHopPeerIds,
            expectedRecipientPeerIds: [
                ...settlement.confirmedPeerIds,
                ...settlement.unconfirmedPeerIds
            ],
            confirmedRecipientPeerIds: [...settlement.confirmedPeerIds],
            unconfirmedRecipientPeerIds: [...settlement.unconfirmedPeerIds]
        }
    };
}

/** After a hand-over only the carrier that took the message may move its receipt; the left one speaks for its own leg. */
function isLeftCarrierReceipt(
    lifecycle: ALDeliveryLifecycle,
    settlement: ALDeliverySettlement
): boolean {
    return lifecycle.evidence.carrierFallback?.from === settlement.carrier &&
        (settlement.kind === 'acknowledgement' || settlement.kind === 'receipt-exhausted' ||
            settlement.kind === 'relay-rejected');
}

function toCarrierFallbackLifecycle(
    previous: ALDeliveryLifecycle,
    settlement: ALDeliveryCarrierFallbackSettlement
): ALDeliveryLifecycle {
    const { carrier: from, to, reason, atMs, detail } = settlement;
    return {
        ...previous,
        evidence: { ...previous.evidence, carrierFallback: { from, to, reason, atMs, detail } }
    };
}

function toDurabilityDowngradeLifecycle(
    previous: ALDeliveryLifecycle,
    settlement: ALDeliveryDurabilityDowngradeSettlement
): ALDeliveryLifecycle {
    const { requested, cause } = settlement;
    return {
        ...previous,
        evidence: { ...previous.evidence, durabilityDowngrade: { requested, cause } }
    };
}

const AL_DELIVERY_FAILURE_STATES: Readonly<Record<ALDeliveryFailure['kind'], ALDeliveryState>> = {
    refused: 'rejected',
    'relay-rejected': 'rejected',
    'admission-failed': 'failed',
    'storage-unavailable': 'failed',
    skipped: 'failed',
    unroutable: 'failed',
    'attempt-failed': 'failed',
    'receipt-exhausted': 'failed',
    expired: 'expired'
};

function toFailureLifecycle(
    previous: ALDeliveryLifecycle,
    failure: ALDeliveryFailure,
    reason: string | undefined
): ALDeliveryLifecycle {
    return {
        ...previous,
        state: AL_DELIVERY_FAILURE_STATES[failure.kind],
        evidence: { ...previous.evidence, failure, reason }
    };
}

/** Narrowed so a `rejected`, `failed` or `expired` end cannot skip `failure`. */
type ALDeliveryUnfailedEnd = Extract<ALDeliveryState, 'superseded' | 'cancelled' | 'unobservable'>;

function toReasonedLifecycle(
    previous: ALDeliveryLifecycle,
    state: ALDeliveryUnfailedEnd,
    reason: string | undefined
): ALDeliveryLifecycle {
    return { ...previous, state, evidence: { ...previous.evidence, reason } };
}

function toReceiptExhaustedFailure(
    settlement: ALDeliveryReceiptExhaustedSettlement
): ALDeliveryFailure {
    return settlement.cause === 'budget'
        ? { kind: 'receipt-exhausted', cause: 'budget' }
        : {
            kind: 'receipt-exhausted',
            cause: 'hop-refused',
            hopPeerId: settlement.hopPeerId,
            nackReason: settlement.nackReason
        };
}

interface AdmittedAdmission {
    readonly state: ALDeliveryState;
    readonly atMs: number;
    /** Undefined for a duplicate, which states nothing about the durability of the original admission. */
    readonly durable: boolean | undefined;
    readonly trackedReceiptAlgo: ALAckAlgo;
}

/** A duplicate states nothing about the durability of the original admission, so it keeps the recorded one. */
function toAdmittedAdmission(
    previous: ALDeliveryLifecycle,
    settlement: ALDeliveryAdmissionSettlement,
    verdict: Extract<ALDeliveryAdmissionVerdict, Readonly<{ kind: 'admitted' | 'duplicate'; }>>
): AdmittedAdmission {
    return verdict.kind === 'admitted'
        ? {
            state: verdict.queuedAttempts > 0 ? 'queued' : 'accepted',
            atMs: settlement.atMs,
            durable: verdict.durable,
            trackedReceiptAlgo: settlement.trackedReceiptAlgo
        }
        : {
            state: 'accepted',
            atMs: settlement.atMs,
            durable: previous.evidence.admittedDurable,
            trackedReceiptAlgo: settlement.trackedReceiptAlgo
        };
}

/**
 * The handle waits for the receipt the admitting carrier tracks, never one it cannot settle (R-S3a-4).
 * An admission that reaches the handle after the carrier already sent keeps `transport-accepted`.
 */
function toAdmittedLifecycle(
    previous: ALDeliveryLifecycle,
    admission: AdmittedAdmission
): ALDeliveryLifecycle {
    return {
        ...previous,
        state: previous.state === 'transport-accepted' ? previous.state : admission.state,
        receiptAlgo: admission.trackedReceiptAlgo,
        evidence: {
            ...previous.evidence,
            admittedAtMs: admission.atMs,
            admittedDurable: admission.durable,
            receiptDowngrade: toReceiptDowngrade(previous.receiptAlgo, admission.trackedReceiptAlgo) ??
                previous.evidence.receiptDowngrade
        }
    };
}

const AL_ACK_ALGO_STRENGTH: Readonly<Record<ALAckAlgo, number>> = { none: 0, hop: 1, subtree: 2, receiver: 3 };

function toReceiptDowngrade(requested: ALAckAlgo, tracked: ALAckAlgo): ALDeliveryReceiptDowngrade | undefined {
    return AL_ACK_ALGO_STRENGTH[tracked] < AL_ACK_ALGO_STRENGTH[requested] ? { requested, tracked } : undefined;
}

interface AdmissionAttemptFacts {
    readonly carrier: ALDeliveryCarrier;
    readonly atMs: number;
    readonly detail: string;
}

/** A carrier admission that never reached the transport, with the reason its own outcome states. */
type AdmissionAttempt =
    | AdmissionAttemptFacts & Readonly<{ outcome: 'unroutable'; reason: ALDeliveryUnroutableReason; }>
    | AdmissionAttemptFacts & Readonly<{ outcome: 'refused'; reason: ALDeliveryRefusalReason; }>;

/** The reducer's own synthetic attempt row for a carrier admission that never reached the transport. */
function toAdmissionAttemptLifecycle(
    previous: ALDeliveryLifecycle,
    admission: AdmissionAttempt
): ALDeliveryLifecycle {
    const attempt: ALDeliveryAttempt = {
        attemptId: `admission:${admission.carrier}:${admission.atMs}`,
        carrier: admission.carrier,
        startedAtMs: admission.atMs,
        settledAtMs: admission.atMs,
        outcome: admission.outcome,
        submissionAttempted: false,
        detail: admission.detail,
        unroutableReason: admission.outcome === 'unroutable' ? admission.reason : undefined,
        refusalReason: admission.outcome === 'refused' ? admission.reason : undefined
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
        detail: undefined,
        unroutableReason: undefined,
        refusalReason: undefined
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
    /**
     * A message can have several attempts at once (one send-prepared row per next-hop peer): a
     * non-retrying failure only fails the send when no hop in evidence already carried it.
     */
    if (
        (settlement.outcome === 'failed' || settlement.outcome === 'no-targets') &&
        !settlement.willRetry &&
        !hasSentAttempt(next.evidence)
    ) {
        return toFailureLifecycle(
            next,
            { kind: 'attempt-failed', outcome: settlement.outcome },
            settlement.detail
        );
    }
    if (settlement.outcome === 'expired') {
        return toFailureLifecycle(next, { kind: 'expired' }, settlement.detail);
    }
    if (settlement.outcome === 'superseded') {
        return toReasonedLifecycle(next, 'superseded', settlement.detail);
    }
    return next;
}

function hasSentAttempt(evidence: ALDeliveryEvidence): boolean {
    return evidence.attempts.some((attempt) => attempt.outcome === 'sent');
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
        detail: settlement.detail,
        unroutableReason: existing?.unroutableReason,
        refusalReason: existing?.refusalReason
    };
}

function toAcknowledgementEvidence(
    evidence: ALDeliveryEvidence,
    settlement: ALDeliveryAcknowledgementSettlement
): ALDeliveryEvidence {
    return {
        ...evidence,
        receiptMode: settlement.mode,
        confirmedHopPeerIds: [...settlement.confirmedHopPeerIds],
        unconfirmedHopPeerIds: [...settlement.unconfirmedHopPeerIds],
        expectedRecipientPeerIds: [...settlement.expectedRecipientPeerIds],
        confirmedRecipientPeerIds: [...settlement.confirmedRecipientPeerIds],
        unconfirmedRecipientPeerIds: [...settlement.unconfirmedRecipientPeerIds]
    };
}
