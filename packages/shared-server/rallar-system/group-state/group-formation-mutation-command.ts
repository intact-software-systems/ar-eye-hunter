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
            degraded: input.degraded
        }
    } as const;
    const commandId = groupFormationCriterionRequestId(
        input.degraded ? 'activate-degraded' : 'activate',
        input.groupRef,
        input.formationEpoch
    );
    return { ...semanticCommand, commandId, requestId: commandId };
}

export function toFailFormationCommand(
    input: Readonly<{
        groupRef: GroupRef;
        formationEpoch: number;
        observedRate: number;
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
            observedRate: input.observedRate
        }
    } as const;
    const commandId = groupFormationCriterionRequestId(
        'fail-formation',
        input.groupRef,
        input.formationEpoch
    );
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
            traceId: null
        }
    } as const;
    const commandId = groupFormationCriterionRequestId(
        'retry-establish',
        input.groupRef,
        input.formationEpoch
    );
    return { ...semanticCommand, commandId, requestId: commandId };
}

function groupFormationCriterionRequestId(
    decision: 'activate' | 'activate-degraded' | 'fail-formation' | 'retry-establish',
    groupRef: GroupRef,
    formationEpoch: number
): string {
    return `formation-criterion:v1:${decision}:${serializeCanonicalJson({ groupRef, formationEpoch })}`;
}
