import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { parseALControlMessage } from '../../al-contracts/al-control.ts';
import type { ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import type { Either } from '../../resilience/Either.ts';
import type { ALDeliveryCarrier } from '../delivery/al-delivery-lifecycle.ts';
import type { ALWorkOutcome } from '../work/al-work-queue-port.ts';
import type { ALInboundDurableEffect } from './al-inbound-admission-store.ts';
import type { ALInboundMessageRuntime } from './al-inbound-message-runtime.ts';

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
        /** The carrier the message arrived on. */
        carrier: ALDeliveryCarrier;
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
        /**
         * When the batch's run loop started, after its selection and reservation: every claim's
         * `batchStartedAtMs`. `durationMs` and `queueWaitMs` run from the batch's own earlier start.
         */
        startedAtMs: number;
        /** The batch's run order; each id is also a `claim-settled.effectId` unless that claim threw. */
        claimedEffectIds: readonly string[];
        /** Due rows this batch's page saw and did not run, oldest first. */
        deferred: readonly ALInboundDeferredEffect[];
    }>
    | Readonly<{
        kind: 'claim-settled';
        workerId: string;
        effectId: string;
        /** The claimed message. Null for `release-buffered`, which names a track and a sequence and no message. */
        msgId: string | null;
        /** The message the effect acts on: the join key from an ACK back to the delivery it acknowledges. */
        subjectMsgId: string | null;
        /**
         * The claimed message's type. Null for `dispatch-local` and `forward-message`, whose effect
         * retains only a message reference, and for `release-buffered`, which retains neither.
         */
        typeId: string | null;
        payloadKind: ALInboundDurableEffect['kind'];
        /** What this claim's own work cost, from the decoded effect to the outcome it returned. */
        durationMs: number;
        /** Processing attempts the row has spent, this claim included. */
        attempts: number;
        outcome: ALWorkOutcome['status'];
        /** How long the row had been due when its batch's run loop started: `batchStartedAtMs − dueAtMs`. */
        queueWaitMs: number;
        dueAtMs: number;
        /** When the batch's run loop started, after its selection and reservation and before its first claim. */
        batchStartedAtMs: number;
        /** When this claim's own work began, so `startedAtMs − batchStartedAtMs` is its wait behind earlier claims. */
        startedAtMs: number;
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
        /** How many of those rounds saw a due row they did not run. */
        deferredRoundCount: number;
        /** The due rows the latest such round did not run, oldest first. */
        latestDeferred: readonly ALInboundDeferredEffect[];
    }>;

export interface ALInboundDeferredEffect {
    readonly effectId: string;
    readonly dueAtMs: number;
}

export type ALInboundRuntimeDiagnosticsSink = (event: ALInboundRuntimeDiagnosticsEvent) => void;

/**
 * What a claimed effect says about the message it runs, for the join back to its
 * `admission-outcome`. Null is absence, not a name: `payloadKind` says which effect withheld it.
 */
export interface ALInboundClaimIdentity {
    readonly msgId: string | null;
    readonly typeId: string | null;
    readonly subjectMsgId: string | null;
}

/**
 * A retained message answers with its own identity. A delivery effect holds only a reference, which
 * carries the id and not the type, and a buffered release names a track and a sequence rather than
 * any message at all. The subject is the message the effect acts on -- a control's is the message it
 * acknowledges, nacks or repairs, not its own envelope. Every kind is listed, so a seventh one has to
 * decide what it reports.
 */
export function toALInboundClaimIdentity(payload: ALInboundDurableEffect): ALInboundClaimIdentity {
    switch (payload.kind) {
        case 'admit-message':
            return {
                msgId: payload.msg.id.msgId,
                typeId: payload.msg.payload.typeId,
                subjectMsgId: payload.msg.id.msgId
            };
        case 'admit-control':
        case 'send-control':
            return {
                msgId: payload.msg.id.msgId,
                typeId: payload.msg.payload.typeId,
                subjectMsgId: toALControlSubjectMsgId(payload.msg)
            };
        case 'dispatch-local':
        case 'forward-message':
            return { msgId: payload.message.msgId, typeId: null, subjectMsgId: payload.message.msgId };
        case 'release-buffered':
            return { msgId: null, typeId: null, subjectMsgId: null };
    }
}

/** An ACK names the message it acknowledges; a NACK and a repair name the message they concern. */
function toALControlSubjectMsgId(msg: ALMessage): string | null {
    const control = parseALControlMessage(msg);
    if (control === undefined) {
        return null;
    }
    return control.type === 'ack' ? control.payload.ackedMsgId : control.payload.msgId;
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
