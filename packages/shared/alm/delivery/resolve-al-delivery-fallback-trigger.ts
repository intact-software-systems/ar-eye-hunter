import type {
    ALDeliveryAdmissionVerdict,
    ALDeliveryAttemptOutcome,
    ALDeliveryCarrier,
    ALDeliveryFallbackReason,
    ALDeliveryRefusalReason,
    ALDeliverySettlement,
    ALDeliveryUnroutableReason
} from './al-delivery-lifecycle.ts';

/** Consecutive `not-ready` settlements of one message's RTC attempts, across its send-prepared rows, that hand it to WS (D56). */
export const AL_FALLBACK_NOT_READY_ATTEMPTS = 3;

/** The unroutable admission verdicts a fallback strategy hands to its other carrier at once: every one (D56 adds `rate-limited`). */
export const AL_DELIVERY_FALLBACK_UNROUTABLE_REASONS: readonly ALDeliveryUnroutableReason[] = [
    'no-route',
    'circuit-open',
    'rate-limited'
];

/** The refusals that do the same: a carrier that cannot honour the ack algorithm keeps the algorithm, not the carrier (D42). */
export const AL_DELIVERY_FALLBACK_REFUSAL_REASONS: readonly ALDeliveryRefusalReason[] = [
    'unsupported'
];

/** What ends an admitted RTC leg and hands the message to WS inside its deadline (D56). */
export const AL_DELIVERY_FALLBACK_REASONS: readonly ALDeliveryFallbackReason[] = [
    'not-ready',
    'not-yet-in-sync-exhausted',
    'receipt-exhausted'
];

export interface ResolveALDeliveryFallbackTriggerInput {
    readonly settlement: ALDeliverySettlement;
    /** The carrier of the watched leg: a settlement of any other carrier moves nothing. */
    readonly leg: ALDeliveryCarrier;
    /** Consecutive `not-ready` attempts counted before this settlement. */
    readonly notReadyRun: number;
}

export type ALDeliveryFallbackTrigger =
    | Readonly<{ kind: 'continue'; notReadyRun: number; }>
    | Readonly<{ kind: 'fall-back'; reason: ALDeliveryFallbackReason; detail: string; }>;

export function isALDeliveryAdmissionFallbackVerdict(verdict: ALDeliveryAdmissionVerdict): boolean {
    switch (verdict.kind) {
        case 'unroutable':
            return AL_DELIVERY_FALLBACK_UNROUTABLE_REASONS.includes(verdict.reason);
        case 'refused':
            return AL_DELIVERY_FALLBACK_REFUSAL_REASONS.includes(verdict.reason);
        default:
            return false;
    }
}

/** A `sent` attempt or an acknowledgement proves the leg carries, so it restarts the `not-ready` count. */
export function resolveALDeliveryFallbackTrigger(
    input: ResolveALDeliveryFallbackTriggerInput
): ALDeliveryFallbackTrigger {
    const { settlement, notReadyRun } = input;
    if (settlement.carrier !== input.leg) {
        return { kind: 'continue', notReadyRun };
    }
    switch (settlement.kind) {
        case 'attempt-settled':
            return toAttemptTrigger(settlement.outcome, notReadyRun);
        case 'acknowledgement':
            return { kind: 'continue', notReadyRun: 0 };
        case 'not-yet-in-sync-exhausted':
        case 'receipt-exhausted':
            return { kind: 'fall-back', reason: settlement.kind, detail: settlement.detail };
        default:
            return { kind: 'continue', notReadyRun };
    }
}

function toAttemptTrigger(
    outcome: ALDeliveryAttemptOutcome,
    notReadyRun: number
): ALDeliveryFallbackTrigger {
    if (outcome === 'sent') {
        return { kind: 'continue', notReadyRun: 0 };
    }
    if (outcome !== 'not-ready') {
        return { kind: 'continue', notReadyRun };
    }
    const run = notReadyRun + 1;
    return run >= AL_FALLBACK_NOT_READY_ATTEMPTS
        ? {
            kind: 'fall-back',
            reason: 'not-ready',
            detail: `${run} consecutive RTC attempts settled not-ready.`
        }
        : { kind: 'continue', notReadyRun: run };
}
