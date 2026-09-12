import type { ALAckMode } from '../../al-contracts/al-contract.ts';

export type ALDeliveryState =
    | 'submitted'
    | 'rejected'
    | 'pending-authority'
    | 'accepted'
    | 'queued'
    | 'transport-accepted'
    | 'acknowledged'
    | 'expired'
    | 'superseded'
    | 'failed'
    | 'cancelled'
    | 'unobservable';

/** Every state, in lifecycle order; the harness decoders and the capability prose derive from it. */
export const AL_DELIVERY_STATES: readonly ALDeliveryState[] = [
    'submitted',
    'rejected',
    'pending-authority',
    'accepted',
    'queued',
    'transport-accepted',
    'acknowledged',
    'expired',
    'superseded',
    'failed',
    'cancelled',
    'unobservable'
];

/** The states a wait for admission resolves on: everything the first verdict can produce. */
export const AL_DELIVERY_ADMITTED_STATES: readonly ALDeliveryState[] = AL_DELIVERY_STATES.filter(
    (state) => state !== 'submitted'
);

export type ALDeliveryCarrier = 'rtc' | 'ws';

/** What one carrier's attempt settled to; the seven transport outcomes plus a refused admission. */
export type ALDeliveryAttemptOutcome =
    | 'sent'
    | 'not-ready'
    | 'failed'
    | 'no-targets'
    | 'cancelled'
    | 'expired'
    | 'superseded'
    | 'unroutable';

export type ALDeliveryAdmissionVerdict =
    | Readonly<{ kind: 'admitted'; durable: boolean; queuedAttempts: number; }>
    | Readonly<{ kind: 'duplicate'; }>
    /** A retained admission conflict: the owner replays it; the handle stays `submitted`. */
    | Readonly<{ kind: 'pending'; }>
    | Readonly<{ kind: 'deferred'; reason: 'not-yet-in-sync'; detail: string; }>
    | Readonly<{
        kind: 'refused';
        reason: 'unauthorized' | 'malformed' | 'oversized' | 'unsupported';
        detail: string;
    }>
    | Readonly<{
        kind: 'unroutable';
        reason: 'no-route' | 'rate-limited' | 'circuit-open';
        detail: string;
    }>
    | Readonly<{ kind: 'superseded'; detail: string; }>
    | Readonly<{ kind: 'expired'; detail: string; }>
    | Readonly<{
        kind: 'skipped';
        reason: 'disposed' | 'repair-exhausted' | 'pending-terminated' | 'planner-drop';
        detail: string;
    }>
    | Readonly<{ kind: 'failed'; detail: string; }>;

export type ALDeliverySettlement =
    | Readonly<{
        kind: 'admission';
        msgId: string;
        carrier: ALDeliveryCarrier;
        atMs: number;
        verdict: ALDeliveryAdmissionVerdict;
    }>
    /** The sender's strategy has no carrier left to try after an `unroutable` verdict. */
    | Readonly<{
        kind: 'attempts-exhausted';
        msgId: string;
        carrier: ALDeliveryCarrier;
        atMs: number;
        detail: string;
    }>
    | Readonly<{
        kind: 'attempt-started';
        msgId: string;
        carrier: ALDeliveryCarrier;
        atMs: number;
        attemptId: string;
    }>
    | Readonly<{
        kind: 'attempt-settled';
        msgId: string;
        carrier: ALDeliveryCarrier;
        atMs: number;
        attemptId: string;
        outcome: ALDeliveryAttemptOutcome;
        submissionAttempted: boolean;
        detail: string | undefined;
        /** The owner keeps the row and will attempt again; a settled attempt that ends the message says false. */
        willRetry: boolean;
    }>
    | Readonly<{
        kind: 'acknowledgement';
        msgId: string;
        carrier: ALDeliveryCarrier;
        atMs: number;
        confirmedHopPeerIds: readonly string[];
        unconfirmedHopPeerIds: readonly string[];
        complete: boolean;
    }>
    | Readonly<{
        kind: 'expired';
        msgId: string;
        carrier: ALDeliveryCarrier;
        atMs: number;
        detail: string;
    }>
    | Readonly<{ kind: 'cancelled'; msgId: string; carrier: ALDeliveryCarrier; atMs: number; }>;

export type ALDeliverySettlementSink = (settlement: ALDeliverySettlement) => void;

export interface ALDeliveryAttempt {
    readonly attemptId: string;
    readonly carrier: ALDeliveryCarrier;
    readonly startedAtMs: number;
    /** Undefined while the carrier still owns the attempt. */
    readonly settledAtMs: number | undefined;
    readonly outcome: ALDeliveryAttemptOutcome | undefined;
    readonly submissionAttempted: boolean;
    readonly detail: string | undefined;
}

export interface ALDeliveryEvidence {
    readonly submittedAtMs: number;
    /** Undefined until an `admitted` or `duplicate` verdict. */
    readonly admittedAtMs: number | undefined;
    readonly attempts: readonly ALDeliveryAttempt[];
    readonly confirmedHopPeerIds: readonly string[];
    readonly unconfirmedHopPeerIds: readonly string[];
    /** The detail of the settlement that made the state terminal; undefined before that. */
    readonly reason: string | undefined;
}

export interface ALDeliveryLifecycle {
    readonly msgId: string;
    readonly typeId: string;
    readonly ackMode: ALAckMode;
    /** Undefined only for a message without a deadline; every browser send carries one. */
    readonly expiresAtMs: number | undefined;
    readonly state: ALDeliveryState;
    readonly evidence: ALDeliveryEvidence;
    /** Settlements that arrived after a terminal state; they never reopen it. */
    readonly lateSettlementCount: number;
}

export interface CreateInitialALDeliveryLifecycleInput {
    readonly msgId: string;
    readonly typeId: string;
    readonly ackMode: ALAckMode;
    readonly expiresAtMs: number | undefined;
    readonly submittedAtMs: number;
}

const AL_DELIVERY_TERMINAL_STATES: readonly ALDeliveryState[] = [
    'rejected',
    'acknowledged',
    'expired',
    'superseded',
    'failed',
    'cancelled',
    'unobservable'
];

export function createInitialALDeliveryLifecycle(
    input: CreateInitialALDeliveryLifecycleInput
): ALDeliveryLifecycle {
    return {
        msgId: input.msgId,
        typeId: input.typeId,
        ackMode: input.ackMode,
        expiresAtMs: input.expiresAtMs,
        state: 'submitted',
        evidence: {
            submittedAtMs: input.submittedAtMs,
            admittedAtMs: undefined,
            attempts: [],
            confirmedHopPeerIds: [],
            unconfirmedHopPeerIds: [],
            reason: undefined
        },
        lateSettlementCount: 0
    };
}

/** `transport-accepted` is terminal only for a best-effort send (`ackMode === 'none'`). */
export function isALDeliveryTerminalState(state: ALDeliveryState, ackMode: ALAckMode): boolean {
    return AL_DELIVERY_TERMINAL_STATES.includes(state) ||
        (state === 'transport-accepted' && ackMode === 'none');
}

export function isALDeliveryTerminal(lifecycle: ALDeliveryLifecycle): boolean {
    return isALDeliveryTerminalState(lifecycle.state, lifecycle.ackMode);
}
