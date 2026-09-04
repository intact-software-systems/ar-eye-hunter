import { resolveGroupTopologyConfig } from '../group-topology-config.ts';
import { computeTopologyConfigMutation } from './compute-topology-config-mutation.ts';
import type {
    GroupTopologyConfigMutationComputed,
    TopologyConfigMutationInput
} from './group-topology-config-mutation-contracts.ts';
import {
    requireTopologyConfigRequestId,
    validateTopologyConfigMutationInput
} from './validate-topology-config-mutation-input.ts';
import {
    validateGroupTopologyConfigMutationRecord,
    validateStoredGroupTopologyConfig,
    validateStoredGroupTopologyOverride
} from './validate-topology-config-records.ts';

export interface ValidateTopologyConfigMutationInput extends TopologyConfigMutationInput {
    readonly computed: GroupTopologyConfigMutationComputed;
}

export function validateTopologyConfigMutation(
    topologyValidation: ValidateTopologyConfigMutationInput
): void {
    validateTopologyConfigMutationInput(topologyValidation);
    const computed = topologyValidation.computed;
    const canonical = computeTopologyConfigMutation(topologyValidation);
    if (JSON.stringify(computed) !== JSON.stringify(canonical)) {
        const operation = topologyValidation.command.operation;
        throw new TypeError(
            `Topology config ${operation} mutation differs from its canonical deterministic projection`
        );
    }
    if (computed.outcome === 'write' || computed.outcome === 'claim') {
        validateWrittenOrClaimedTopologyConfigMutation({ ...topologyValidation, computed });
    }
    if (computed.outcome === 'write') {
        validateTopologyConfigWrite(topologyValidation, computed);
    }
}

function validateTopologyConfigWrite(
    topologyValidation: ValidateTopologyConfigMutationInput,
    computed: Extract<GroupTopologyConfigMutationComputed, { outcome: 'write'; }>
): void {
    const guard = computed.guard;
    if (guard.operation === 'delete') {
        resolveGroupTopologyConfig({
            serverOptions: topologyValidation.serverDefaults,
            durable: guard.target === 'config' ? undefined : topologyValidation.read.config?.value,
            temporary: guard.target === 'override' ? undefined : topologyValidation.read.override?.value
        });
        return;
    }
    if (guard.target === 'config') {
        validateStoredGroupTopologyConfig(guard.value, topologyValidation.command.aggregateRef);
        resolveGroupTopologyConfig({
            serverOptions: topologyValidation.serverDefaults,
            durable: guard.value,
            temporary: topologyValidation.read.override?.value
        });
        return;
    }
    validateStoredGroupTopologyOverride(guard.value, topologyValidation.command.aggregateRef);
    resolveGroupTopologyConfig({
        serverOptions: topologyValidation.serverDefaults,
        durable: topologyValidation.read.config?.value,
        temporary: guard.value
    });
}

function validateWrittenOrClaimedTopologyConfigMutation(
    topologyValidation:
        & ValidateTopologyConfigMutationInput
        & Readonly<{
            computed: Extract<GroupTopologyConfigMutationComputed, { outcome: 'write' | 'claim'; }>;
        }>
): void {
    if (topologyValidation.computed.receipt.commandHash !== topologyValidation.command.commandHash) {
        throw new TypeError('Topology config receipt hash differs from command');
    }
    if (topologyValidation.computed.idempotency !== null) {
        validateGroupTopologyConfigMutationRecord(topologyValidation.computed.idempotency, {
            groupRef: topologyValidation.command.aggregateRef,
            requestId: requireTopologyConfigRequestId(topologyValidation.command)
        });
    }
}
