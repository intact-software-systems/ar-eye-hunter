import {
    assertRuntimeStateExpectedRevision,
    assertRuntimeStateUpsertExpectedRevision
} from '../../../../runtime-state/runtime-state-repository.ts';
import { validateAppInboxComputedProjection } from '../../../app-inbox/handler/app-inbox-computed-validation.ts';
import { computeTopologyConfigMutation } from './compute-topology-config-mutation.ts';
import type {
    GroupTopologyConfigMutationComputed,
    TopologyConfigMutationInput
} from './group-topology-config-mutation-contracts.ts';
import { requireTopologyConfigRequestId } from './validate-topology-config-mutation-input.ts';
import { validateGroupTopologyConfigMutationRecord } from './validate-topology-config-records.ts';

export interface ValidateTopologyConfigMutationInput extends TopologyConfigMutationInput {
    readonly computed: GroupTopologyConfigMutationComputed;
}

export function validateTopologyConfigMutation(
    topologyValidation: ValidateTopologyConfigMutationInput
): void {
    const computed = topologyValidation.computed;
    const canonical = computeTopologyConfigMutation(topologyValidation);
    const issues = validateAppInboxComputedProjection(canonical, computed, 'topology config mutation');
    if (issues.length > 0) {
        const operation = topologyValidation.command.operation;
        throw new TypeError(
            `Topology config ${operation} mutation differs from its canonical deterministic projection`
        );
    }
    if (computed.outcome === 'write' || computed.outcome === 'claim') {
        validateWrittenOrClaimedTopologyConfigMutation({ ...topologyValidation, computed });
    }
}

function validateWrittenOrClaimedTopologyConfigMutation(
    topologyValidation:
        & ValidateTopologyConfigMutationInput
        & Readonly<{
            computed: Extract<GroupTopologyConfigMutationComputed, { outcome: 'write' | 'claim'; }>;
        }>
): void {
    if (topologyValidation.computed.receipt.commandHash !== topologyValidation.facts.commandHash) {
        throw new TypeError('Topology config receipt hash differs from facts');
    }
    if (topologyValidation.computed.idempotency !== null) {
        validateGroupTopologyConfigMutationRecord(topologyValidation.computed.idempotency, {
            groupRef: topologyValidation.command.aggregateRef,
            requestId: requireTopologyConfigRequestId(topologyValidation.command)
        });
    }
    for (const write of topologyValidation.computed.runtimeWrites) {
        if (write.operation === 'update') {
            assertRuntimeStateUpsertExpectedRevision(write.expectedRevision);
        }
        else if (write.operation === 'delete') {
            assertRuntimeStateExpectedRevision(write.expectedRevision);
        }
    }
}
