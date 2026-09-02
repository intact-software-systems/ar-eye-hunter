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
        /** Null when no layout is left to fence: the deadline's plan-less failure (plan slice 11a). */
        expectedLayout: GroupLayoutIdentity | null;
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

export interface FormationAutomationPlanInput {
    readonly groupRef: GroupRef;
    readonly formationEpoch: number;
}

export interface FormationTriggerPlanInput extends FormationAutomationPlanInput {
    /** The write that armed the trigger: a re-created group restarts its epochs, and must not replay its previous life's plan. */
    readonly groupSnapshotVersion: number;
}

/**
 * The retry leg replans after a below-floor return: the same automation
 * that was sanctioned by the original plan/connect, bounded by
 * maxFormationAttempts and paced by the backoff that scheduled this.
 */
export function toFormationRetryPlanCommand(input: FormationAutomationPlanInput): GroupMutationCommand {
    const identity = serializeCanonicalJson({ groupRef: input.groupRef, formationEpoch: input.formationEpoch });
    return toAutomationPlanCommand(input, `formation-automation:v2:retry-plan:${identity}`);
}

/** The plan trigger's command (product decision 8): the automation plan, keyed as the trigger's own. */
export function toFormationTriggerPlanCommand(input: FormationTriggerPlanInput): GroupMutationCommand {
    const identity = serializeCanonicalJson({
        groupRef: input.groupRef,
        formationEpoch: input.formationEpoch,
        groupSnapshotVersion: input.groupSnapshotVersion
    });
    return toAutomationPlanCommand(input, `formation-automation:v1:trigger-plan:${identity}`);
}

function toAutomationPlanCommand(input: FormationAutomationPlanInput, commandId: string): GroupMutationCommand {
    return {
        operation: 'planGroupLayout',
        aggregateRef: input.groupRef,
        commandId,
        requestId: commandId,
        input: {
            actorPrincipalId: null,
            actorSessionId: null,
            reason: null,
            traceId: null,
            expectedFormationEpoch: input.formationEpoch
        }
    };
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
