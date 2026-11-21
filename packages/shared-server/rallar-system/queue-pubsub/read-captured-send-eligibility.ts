import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALOutboundCapturedPolicy } from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';
import type { Key } from '@shared/queuebox/ResourceEntry.ts';
import type { Timers } from '@shared/resilience/timers.ts';
import { readWsQueueBoxServerEligibleAudience } from '@shared/services/ws-queue-box-server/scope/read-ws-queue-box-server-eligible-audience.ts';
import { isWsQueueBoxServerCapturedSessionRow } from '@shared/services/ws-queue-box-server/scope/to-ws-queue-box-server-captured-send-input.ts';
import type { WsCapturedRecipientEligibilityFilters } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';

/**
 * The captured sessions a local send may address; undefined leaves the send to resolve the row's targets. Only a
 * re-check judges, so only a re-checked send drops the captured sessions it did not keep.
 */
export type CapturedSendEligibility =
    | Readonly<{ rechecked: true; eligibleSessionIds: readonly string[]; }>
    | Readonly<{ rechecked: false; eligibleSessionIds: readonly string[] | undefined; }>;

export interface CapturedSendEligibilityInput {
    readonly message: ALMessage;
    readonly key: Key;
    readonly policy: ALOutboundCapturedPolicy | undefined;
    /** Whether the row reaches only the audience frozen at its admission (a granted topic). */
    readonly frozen: boolean;
    /** The captured sessions this attempt's dequeue dropped; undefined when no dequeue judged this send. */
    readonly judgedDrops: readonly string[] | undefined;
}

export interface CapturedSendEligibilityDependencies {
    /** Absent, no re-check is wired. */
    readonly capturedRecipientEligibilityFilters?: Pick<WsCapturedRecipientEligibilityFilters, 'local' | 'socket'>;
    readonly timers: Timers;
}

/**
 * Re-checked for a scoped row and a frozen-audience row; nobody, unjudged, for a frozen-audience row with no re-check
 * wired; any other row is left to resolve its targets. A send its dequeue judged keeps the sessions the dequeue kept
 * whose socket here is open, reading nothing; any other send re-checks afresh.
 */
export async function readCapturedSendEligibility(
    input: CapturedSendEligibilityInput,
    dependencies: CapturedSendEligibilityDependencies
): Promise<CapturedSendEligibility> {
    const { message, policy, frozen, judgedDrops } = input;
    const captured = policy?.admittedAudience;
    if (captured === undefined || policy?.sessionInvalidation !== undefined) {
        return { rechecked: false, eligibleSessionIds: undefined };
    }
    if (!frozen && !isWsQueueBoxServerCapturedSessionRow(message, input.key)) {
        return { rechecked: false, eligibleSessionIds: undefined };
    }
    const filters = dependencies.capturedRecipientEligibilityFilters;
    if (filters === undefined) {
        return { rechecked: false, eligibleSessionIds: frozen ? [] : undefined };
    }
    const dropped = new Set(judgedDrops);
    const eligibleSessionIds = await readWsQueueBoxServerEligibleAudience({
        message,
        admittedAudience: captured.filter((sessionId) => !dropped.has(sessionId)),
        admittedConnectionGenerationIds: policy?.admittedConnectionGenerationIds,
        provenScope: policy?.recipientScope,
        filterEligibleCapturedSessionIds: judgedDrops === undefined ? filters.local : filters.socket,
        timers: dependencies.timers
    });
    return { rechecked: true, eligibleSessionIds };
}

/**
 * A send that no re-check judged declares no exclusion: its captured sessions stay expected, none is dropped. A session
 * the dequeue judged out is recorded outside again here as `open-here`, as the former second probe did: those writes
 * are idempotent per session.
 */
export function toCapturedSendDrops(
    policy: ALOutboundCapturedPolicy | undefined,
    eligibility: CapturedSendEligibility
): readonly string[] {
    if (!eligibility.rechecked) {
        return [];
    }
    const eligible = new Set(eligibility.eligibleSessionIds);
    return (policy?.admittedAudience ?? []).filter((sessionId) => !eligible.has(sessionId));
}
