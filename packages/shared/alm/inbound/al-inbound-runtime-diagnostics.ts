import type { ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import type { Either } from '../../resilience/Either.ts';
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
    }>;

export type ALInboundRuntimeDiagnosticsSink = (event: ALInboundRuntimeDiagnosticsEvent) => void;

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
