import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import { serializeCanonicalJson } from '../protocol/canonical-json.ts';
import type { GroupMutationCommand } from './mutation/group-mutation-contracts.ts';

/**
 * Criterion-commanded transitions are idempotent per formation epoch and
 * decision: the evidence producer and the deadline consumer can race to the
 * same conclusion, and the identical command id makes the second firing an
 * inbox replay rather than a second transition.
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
    const commandId = groupFormationCriterionRequestId({
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
    const commandId = groupFormationCriterionRequestId({
        decision: 'fail-formation',
        groupRef: input.groupRef,
        formationEpoch: input.formationEpoch,
        expectedLayout: input.expectedLayout
    });
    return { ...semanticCommand, commandId, requestId: commandId };
}

/**
 * The retry leg re-enters establishment after a below-floor return: the same
 * automation that was sanctioned by the original start-establishment, bounded
 * by maxFormationAttempts and paced by the backoff that scheduled this.
 */
export function toFormationRetryEstablishCommand(
    input: Readonly<{
        groupRef: GroupRef;
        formationEpoch: number;
    }>
): GroupMutationCommand {
    const semanticCommand = {
        operation: 'startGroupEstablishment',
        aggregateRef: input.groupRef,
        input: {
            actorPrincipalId: null,
            actorSessionId: null,
            reason: null,
            traceId: null,
            expectedFormationEpoch: input.formationEpoch
        }
    } as const;
    const commandId = groupFormationCriterionRequestId({
        decision: 'retry-establish',
        groupRef: input.groupRef,
        formationEpoch: input.formationEpoch,
        expectedLayout: null
    });
    return { ...semanticCommand, commandId, requestId: commandId };
}

/**
 * v2 keys the id on the full causal fence, layout identity included, so two
 * petitions against different planned layouts in one epoch are distinct
 * commands rather than a replay of each other (product decision 19).
 */
function groupFormationCriterionRequestId(
    input: Readonly<{
        decision: 'activate' | 'activate-degraded' | 'fail-formation' | 'retry-establish';
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
