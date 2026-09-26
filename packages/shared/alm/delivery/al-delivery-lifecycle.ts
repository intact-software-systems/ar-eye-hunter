import type { ALAckMode } from '../../al-contracts/al-contract.ts';
import type { ALReceiptMode } from '../../al-contracts/al-policy.ts';

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

/** What one carrier attempt settled to; the seven transport outcomes plus an unroutable or refused admission. */
export type ALDeliveryAttemptOutcome =
    | 'sent'
    | 'not-ready'
    | 'failed'
    | 'no-targets'
    | 'cancelled'
    | 'expired'
    | 'superseded'
    | 'unroutable'
    | 'refused';

/** Why a carrier admission found no route: no peer at all, or the sender's own rate limit or open circuit. */
export type ALDeliveryUnroutableReason = 'no-route' | 'rate-limited' | 'circuit-open';

export type ALDeliveryRefusalReason = 'unauthorized' | 'malformed' | 'oversized' | 'unsupported';

export type ALDeliveryAdmissionVerdict =
    | Readonly<{ kind: 'admitted'; durable: boolean; queuedAttempts: number; }>
    | Readonly<{ kind: 'duplicate'; }>
    /** A retained admission conflict: the owner replays it; the handle stays `submitted`. */
    | Readonly<{ kind: 'pending'; }>
    | Readonly<{ kind: 'deferred'; reason: 'not-yet-in-sync'; detail: string; }>
    | Readonly<{ kind: 'refused'; reason: ALDeliveryRefusalReason; detail: string; }>
    | Readonly<{
        kind: 'unroutable';
        reason: ALDeliveryUnroutableReason;
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
    /** A carrier refused admission and the strategy hands the send to its fallback carrier: evidence, never the verdict. */
    | Readonly<{
        kind: 'carrier-refused';
        msgId: string;
        carrier: ALDeliveryCarrier;
        atMs: number;
        reason: ALDeliveryRefusalReason;
        detail: string;
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
        /** Under `receiver` the peer lists name logical recipients and `complete` is logical completion. */
        mode: ALReceiptMode;
        confirmedHopPeerIds: readonly string[];
        unconfirmedHopPeerIds: readonly string[];
        /** Under `hop` and `subtree` the recipient lists are the hop lists. */
        expectedRecipientPeerIds: readonly string[];
        confirmedRecipientPeerIds: readonly string[];
        unconfirmedRecipientPeerIds: readonly string[];
        complete: boolean;
    }>
    /** A hop refused the message with an admitted NACK (D50): terminal evidence, and no resend follows it. */
    | Readonly<{
        kind: 'relay-rejected';
        msgId: string;
        carrier: ALDeliveryCarrier;
        atMs: number;
        relayRejection: ALDeliveryRelayRejection;
        detail: string;
    }>
    | Readonly<{
        kind: 'expired';
        msgId: string;
        carrier: ALDeliveryCarrier;
        atMs: number;
        detail: string;
    }>
    /** A newer message's admission replaced this one; stated from the replacement's commit, never by an attempt. */
    | Readonly<{
        kind: 'superseded';
        msgId: string;
        carrier: ALDeliveryCarrier;
        atMs: number;
        replacementMsgId: string;
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
    /** Undefined on a carrier attempt: only an `unroutable` admission row states a reason. */
    readonly unroutableReason: ALDeliveryUnroutableReason | undefined;
    /** Undefined but on the row of a refused admission the fallback carrier took over. */
    readonly refusalReason: ALDeliveryRefusalReason | undefined;
}

/**
 * What the latest receipt stated. Under `hop` and `subtree` the recipient lists are the hop lists. Under
 * `receiver` the recipient lists count the frozen logical audience, and the hop lists are the local hop
 * view of the origin: the confirmed hops are the next hops whose own completion ACK arrived, and the
 * unconfirmed hops are the remaining next hops the dispatch sent through. A WS origin names no hop.
 */
export interface ALDeliveryReceiptEvidence {
    /** Undefined until a receipt settles; a send that tracks no receipt never has one. */
    readonly receiptMode: ALReceiptMode | undefined;
    readonly confirmedHopPeerIds: readonly string[];
    readonly unconfirmedHopPeerIds: readonly string[];
    readonly expectedRecipientPeerIds: readonly string[];
    readonly confirmedRecipientPeerIds: readonly string[];
    readonly unconfirmedRecipientPeerIds: readonly string[];
}

/**
 * The hop whose admitted NACK refused the message, and the reason it gave (D50). A trusted server relay
 * is never named: no client learns a server id.
 */
export type ALDeliveryRelayRejection =
    | Readonly<{ relay: 'trusted-server'; reason: 'resync-required'; }>
    | Readonly<{ relay: 'peer'; peerId: string; reason: 'resync-required'; }>;

export interface ALDeliveryEvidence extends ALDeliveryReceiptEvidence {
    readonly submittedAtMs: number;
    /** Undefined until an `admitted` or `duplicate` verdict. */
    readonly admittedAtMs: number | undefined;
    /** Undefined until an `admitted` verdict: a duplicate states nothing about the durability of the original. */
    readonly admittedDurable: boolean | undefined;
    readonly attempts: readonly ALDeliveryAttempt[];
    /**
     * Undefined unless a hop refused the message. An ACK-tracked send then reads `rejected`; a best-effort send
     * keeps its terminal `transport-accepted`, and this field is the only sign of the refusal (R-S2c-ii-5a).
     */
    readonly relayRejection: ALDeliveryRelayRejection | undefined;
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
            admittedDurable: undefined,
            attempts: [],
            receiptMode: undefined,
            confirmedHopPeerIds: [],
            unconfirmedHopPeerIds: [],
            expectedRecipientPeerIds: [],
            confirmedRecipientPeerIds: [],
            unconfirmedRecipientPeerIds: [],
            relayRejection: undefined,
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

export function isALDeliveryAdmitted(lifecycle: ALDeliveryLifecycle): boolean {
    return lifecycle.state === 'accepted' || lifecycle.state === 'queued' ||
        lifecycle.state === 'transport-accepted' || lifecycle.state === 'acknowledged';
}

/**
 * True when the outbox may now hold a row worth draining for this message: a freshly admitted
 * durable verdict, a duplicate of an original presumed present, or a retained admission conflict
 * awaiting replay. A non-durable `admitted` verdict does not qualify — it produced no queue row.
 */
export function hasALDeliveryDurableWork(verdict: ALDeliveryAdmissionVerdict): boolean {
    return (verdict.kind === 'admitted' && verdict.durable) || verdict.kind === 'duplicate' ||
        verdict.kind === 'pending';
}
