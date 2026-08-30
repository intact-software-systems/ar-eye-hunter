import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import { serializeCanonicalJson } from '../protocol/canonical-json.ts';
import type { GroupMutationCommand } from './mutation/group-mutation-contracts.ts';

/**
 * Criterion-commanded transitions are idempotent per decision and full
 * causal fence: two firings naming the same epoch and layout identity share
 * a command id, so the second is an inbox replay. Petitions naming different
 * layout identities are distinct commands, and the loser is stopped by the
 * causal fence's typed rejection at compute — either way, never a second
 * transition.
 */
export function toFormationActivateCommand(
    input: Readonly<{
        groupRef: GroupRef;
        formationEpoch: number;
        observedRate: number;
        degraded: boolean;
        expectedLayout: GroupLayoutIdentity;
    }>
): GroupMutationCommand {
    const semanticCommand = {
        operation: 'activateGroup',
        aggregateRef: input.groupRef,
        input: {
            actorPrincipalId: null,
            actorSessionId: null,
            reason: null,
            traceId: null,
            observedRate: input.observedRate,
            degraded: input.degraded,
            expectedFormationEpoch: input.formationEpoch,
            expectedLayout: input.expectedLayout
        }
    } as const;
    const commandId = toGroupFormationCriterionRequestId({
        decision: input.degraded ? 'activate-degraded' : 'activate',
        groupRef: input.groupRef,
        formationEpoch: input.formationEpoch,
        expectedLayout: input.expectedLayout
    });
    return { ...semanticCommand, commandId, requestId: commandId };
}

export function toFailFormationCommand(
    input: Readonly<{
        groupRef: GroupRef;
        formationEpoch: number;
        observedRate: number;
        expectedLayout: GroupLayoutIdentity;
    }>
): GroupMutationCommand {
    const semanticCommand = {
        operation: 'failGroupFormation',
        aggregateRef: input.groupRef,
        input: {
            actorPrincipalId: null,
            actorSessionId: null,
            reason: null,
            traceId: null,
            observedRate: input.observedRate,
            expectedFormationEpoch: input.formationEpoch,
            expectedLayout: input.expectedLayout
        }
    } as const;
    const commandId = toGroupFormationCriterionRequestId({
        decision: 'fail-formation',
        groupRef: input.groupRef,
        formationEpoch: input.formationEpoch,
        expectedLayout: input.expectedLayout
    });
    return { ...semanticCommand, commandId, requestId: commandId };
}

/**
 * The retry leg replans after a below-floor return: the same
 * automation that was sanctioned by the original plan/connect, bounded
 * by maxFormationAttempts and paced by the backoff that scheduled this.
 */
export function toFormationRetryPlanCommand(
    input: Readonly<{
        groupRef: GroupRef;
        formationEpoch: number;
    }>
): GroupMutationCommand {
    const semanticCommand = {
        operation: 'planGroupLayout',
        aggregateRef: input.groupRef,
        input: {
            actorPrincipalId: null,
            actorSessionId: null,
            reason: null,
            traceId: null,
            expectedFormationEpoch: input.formationEpoch
        }
    } as const;
    const commandId = `formation-automation:v2:retry-plan:${serializeCanonicalJson(input)}`;
    return { ...semanticCommand, commandId, requestId: commandId };
}

/**
 * v2 keys the id on the full causal fence, layout identity included, so two
 * petitions against different planned layouts in one epoch are distinct
 * commands rather than a replay of each other (product decision 19).
 */
function toGroupFormationCriterionRequestId(
    input: Readonly<{
        decision: 'activate' | 'activate-degraded' | 'fail-formation';
        groupRef: GroupRef;
        formationEpoch: number;
        expectedLayout: GroupLayoutIdentity | null;
    }>
): string {
    const identity = serializeCanonicalJson({
        groupRef: input.groupRef,
        formationEpoch: input.formationEpoch,
        expectedLayout: input.expectedLayout
    });
    return `formation-criterion:v2:${input.decision}:${identity}`;
}
