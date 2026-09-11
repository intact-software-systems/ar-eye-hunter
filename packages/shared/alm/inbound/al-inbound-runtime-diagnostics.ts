import type { ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import type { Either } from '../../resilience/Either.ts';
import type { ALWorkReadinessProbeCause } from '../work/al-work-handler.ts';
import type { ALWorkOutcome } from '../work/al-work-queue-port.ts';
import type { ALInboundDurableEffect } from './al-inbound-admission-store.ts';
import type { ALInboundMessageRuntime } from './al-inbound-message-runtime.ts';

/** What a claimed effect reports where it carries no message identity of its own. */
const NO_CLAIMED_MESSAGE = 'none';

/**
 * Where an incoming message stopped. `committed` is the only ending that leaves durable work behind,
 * so a delivery that never arrives either did not reach it or was never claimed by a drain.
 */
export type ALInboundAdmissionOutcome =
    | 'committed'
    | 'not-handled'
    | 'rejected'
    | 'unauthorized'
    | 'pending';

export type ALInboundRuntimeDiagnosticsEvent =
    | Readonly<{
        kind: 'admission-outcome';
        workerId: string;
        /** The message this ingress decided on, so one delivery can be followed to the drain that ran it. */
        msgId: string;
        typeId: string;
        outcome: ALInboundAdmissionOutcome;
        /** The plan's drop reason, the rejection's code, or the acceptance kind that carries neither. */
        reason: string;
    }>
    | Readonly<{
        kind: 'effect-drain';
        workerId: string;
        durationMs: number;
        claimedCount: number;
        completedCount: number;
        rescheduledCount: number;
        rejectedCount: number;
        /** The batch's own page read and its eligibility reads; near zero when the probe below already held the page. */
        selectionDurationMs: number;
        /** The port's reservation of the rows that read cleared. */
        claimDurationMs: number;
        /** Every claim's own work, summed — the same claims `claim-settled` reports one by one. */
        runDurationMs: number;
        /** Every release this batch wrote, summed. */
        releaseDurationMs: number;
        /** How long the earliest claimed row had been due when the batch started. */
        queueWaitMs: number;
    }>
    | Readonly<{
        kind: 'claim-settled';
        workerId: string;
        /** The claimed message, or `none` where the effect names a track rather than a message. */
        msgId: string;
        /** The claimed message's type, or `none` where the effect retains only a reference to it. */
        typeId: string;
        payloadKind: ALInboundDurableEffect['kind'];
        /** What this claim's own work cost, from the decoded effect to the outcome it returned. */
        durationMs: number;
        /** Processing attempts the row has spent, this claim included. */
        attempts: number;
        outcome: ALWorkOutcome['status'];
        /** How long the row had been due when the batch that claimed it started. */
        queueWaitMs: number;
    }>
    | Readonly<{
        kind: 'readiness-probe';
        workerId: string;
        cause: ALWorkReadinessProbeCause;
        /** What storage answered: when work is next due, or `none` for no work at all. */
        readyAtMs: number | 'none';
        /** What that read cost. The rotation's probe holds the page its batch then claims from, so this is that page read. */
        durationMs: number;
    }>
    | Readonly<{
        kind: 'rotation-alive';
        workerId: string;
        /** Empty rounds this one event stands for; the cadence is `AL_INBOUND_ROTATION_ALIVE_EVERY_ROUNDS`. */
        emptyRoundCount: number;
        /** The wall time those rounds spanned, so a slowed rotation reads as a long gap, not an absence. */
        durationMs: number;
        /** The slowest single round of them, so one crawling scan is not averaged away by the rest. */
        longestRoundMs: number;
    }>;

export type ALInboundRuntimeDiagnosticsSink = (event: ALInboundRuntimeDiagnosticsEvent) => void;

/** What a claimed effect says about the message it runs, for the join back to its `admission-outcome`. */
export interface ALInboundClaimIdentity {
    readonly msgId: string;
    readonly typeId: string;
}

/**
 * A retained message answers with its own identity. A delivery effect holds only a reference, which
 * carries the id and not the type, and a buffered release names a track and a sequence rather than
 * any message at all.
 */
export function toALInboundClaimIdentity(payload: ALInboundDurableEffect): ALInboundClaimIdentity {
    switch (payload.kind) {
        case 'admit-message':
        case 'admit-control':
        case 'send-control':
            return { msgId: payload.msg.id.msgId, typeId: payload.msg.payload.typeId };
        case 'dispatch-local':
        case 'forward-message':
            return { msgId: payload.message.msgId, typeId: NO_CLAIMED_MESSAGE };
        default:
            return { msgId: NO_CLAIMED_MESSAGE, typeId: NO_CLAIMED_MESSAGE };
    }
}

export interface ALInboundAdmissionDiagnostics {
    readonly outcome: ALInboundAdmissionOutcome;
    readonly reason: string;
}

/**
 * Names an ending that otherwise leaves no trace at all: an `unauthorized` drop writes nothing,
 * sends no NACK and returns no error, so without this it reads exactly like a delivery still coming.
 */
export function toALInboundAdmissionDiagnostics(
    admitted: Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance>
): ALInboundAdmissionDiagnostics {
    return admitted.fold(toRejectionDiagnostics, toAcceptanceDiagnostics);
}

function toRejectionDiagnostics(rejection: ALMessageRejection): ALInboundAdmissionDiagnostics {
    return {
        outcome: rejection.code === 'unauthorized' ? 'unauthorized' : 'rejected',
        reason: rejection.code
    };
}

function toAcceptanceDiagnostics(
    acceptance: ALInboundMessageRuntime.Acceptance
): ALInboundAdmissionDiagnostics {
    switch (acceptance.kind) {
        case 'admitted':
            return { outcome: 'committed', reason: 'admitted' };
        case 'pending-admission':
            return { outcome: 'pending', reason: 'pending-admission' };
        case 'not-admitted':
            return {
                outcome: acceptance.reason === 'unauthorized' ? 'unauthorized' : 'rejected',
                reason: acceptance.reason
            };
        case 'control':
            return acceptance.handled
                ? { outcome: 'committed', reason: 'control' }
                : { outcome: 'not-handled', reason: 'control' };
        default:
            return { outcome: 'not-handled', reason: acceptance.kind };
    }
}
