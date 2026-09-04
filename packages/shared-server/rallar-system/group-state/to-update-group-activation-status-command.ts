import type { GroupEvidenceWatermark } from '@shared/api/group-lifecycle/compute-group-formation-reading.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { serializeCanonicalJson } from '../protocol/canonical-json.ts';

import type { GroupMutationCommand } from './mutation/group-mutation-contracts.ts';

export interface ToUpdateGroupActivationStatusCommandInput {
    readonly groupRef: GroupRef;
    readonly formationEpoch: number;
    readonly coverageBasisLayoutIdentity: GroupLayoutIdentity;
    readonly coverageRate: number;
    readonly evidenceWatermark: GroupEvidenceWatermark | null;
    readonly replanQueued: boolean;
    readonly layoutStale: boolean;
    /**
     * The durable clock's own write, and the only one that may publish a
     * dwell-held band. It also carries the clock's due instant, because a
     * clock write has no watermark to make its id distinct.
     */
    readonly dwell: Readonly<{ satisfied: boolean; dueAtEpochMs: number; }> | null;
}

/**
 * The status command's id needs a monotonic term, and the reason is the
 * idempotency row rather than the queue: `groupMutationIdempotencyKey`
 * returns the command id, the row never expires, and a repeat resolves to a
 * replay when the hash matches and a 409 when it differs. Keyed only on
 * `(groupRef, formationEpoch, layout)` -- the fence, which is constant within
 * one basis -- `active → degraded` would be a hard conflict and
 * `degraded → active` a silent replay returning the first receipt, so the
 * group would stick at `degraded` for the life of the epoch.
 *
 * The monotonic term is the evidence watermark, which is exactly the fact
 * that distinguishes two readings of one basis, so the id is unique precisely
 * when the observation is new. A clock write carries no watermark -- it
 * observes an absence -- so it keys on its own due instant instead, which the
 * timer owns and never reuses.
 */
function toUpdateGroupActivationStatusCommandId(
    input: ToUpdateGroupActivationStatusCommandInput
): string {
    const identity = serializeCanonicalJson({
        groupRef: input.groupRef,
        formationEpoch: input.formationEpoch,
        coverageBasisLayoutIdentity: input.coverageBasisLayoutIdentity,
        observation: input.dwell === null
            ? { evidenceWatermark: input.evidenceWatermark }
            : { dwellDueAtEpochMs: input.dwell.dueAtEpochMs }
    });
    return `activation-status:v1:${input.dwell === null ? 'evidence' : 'dwell'}:${identity}`;
}

/** The route-less status write; both producers build it here. */
export function toUpdateGroupActivationStatusCommand(
    input: ToUpdateGroupActivationStatusCommandInput
): GroupMutationCommand {
    const commandId = toUpdateGroupActivationStatusCommandId(input);
    return {
        operation: 'updateGroupActivationStatus',
        aggregateRef: input.groupRef,
        commandId,
        requestId: commandId,
        input: {
            actorPrincipalId: null,
            actorSessionId: null,
            reason: null,
            traceId: null,
            expectedFormationEpoch: input.formationEpoch,
            expectedLayout: input.coverageBasisLayoutIdentity,
            coverageRate: input.coverageRate,
            evidenceWatermark: input.evidenceWatermark,
            dwellSatisfied: input.dwell?.satisfied ?? false,
            replanQueued: input.replanQueued,
            layoutStale: input.layoutStale
        }
    };
}
