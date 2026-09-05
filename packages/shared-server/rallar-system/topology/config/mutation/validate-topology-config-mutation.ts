import { validateComputedProjection } from '../../../computed-data-validation.ts';
import {
    GroupTopologyConfigValidationError,
    resolveDefaultGroupTopologyConfig,
    validateEffectiveGroupTopologyConfig
} from '../group-topology-config.ts';
import { computeTopologyConfigMutation } from './compute-topology-config-mutation.ts';
import type {
    GroupTopologyConfigMutationComputed,
    TopologyConfigMutationInput,
    TopologyConfigMutationValidationIssue
} from './group-topology-config-mutation-contracts.ts';

export interface ValidateTopologyConfigMutationInput extends TopologyConfigMutationInput {
    readonly computed: GroupTopologyConfigMutationComputed;
}

export function validateTopologyConfigMutation(
    input: ValidateTopologyConfigMutationInput
): readonly TopologyConfigMutationValidationIssue[] {
    const expected = computeTopologyConfigMutation(input);
    const issues: TopologyConfigMutationValidationIssue[] = validateComputedProjection(
        expected,
        input.computed,
        'computed'
    ).map((issue) => ({
        code: 'computed-projection-invalid',
        path: [issue.path],
        message: issue.message,
        cause: issue.cause
    }));

    if (
        (input.computed.outcome === 'replay' || input.computed.outcome === 'idempotency-conflict') &&
        input.read.idempotency?.value.receipt.operation !== input.command.operation
    ) {
        issues.push({
            code: 'idempotency-operation-mismatch',
            path: ['read', 'idempotency', 'value', 'receipt', 'operation'],
            message: 'Topology config receipt operation differs from command',
            cause: new TypeError('Topology config receipt operation differs from command')
        });
    }
    if (
        input.command.operation === 'putOverride' &&
        input.facts.resolvedOverrideExpiresAtEpochMs === null
    ) {
        issues.push({
            code: 'override-expiry-missing',
            path: ['facts', 'resolvedOverrideExpiresAtEpochMs'],
            message: 'Topology override expiry fact is required',
            cause: new TypeError('Topology override expiry fact is required')
        });
    }
    if (input.computed.outcome !== 'write') {
        return issues;
    }

    const durable = input.computed.guard.target === 'config'
        ? input.computed.guard.value ?? undefined
        : input.read.config?.value;
    const temporary = input.computed.guard.target === 'override'
        ? input.computed.guard.value ?? undefined
        : input.read.override?.value;
    const defaults = resolveDefaultGroupTopologyConfig(input.serverDefaults);
    if (durable !== undefined) {
        appendTopologyConfigIssues(issues, {
            ...defaults,
            ...durable.config
        });
    }
    const effective = {
        ...defaults,
        ...(durable?.config ?? {}),
        ...(temporary?.config ?? {})
    };
    if (temporary !== undefined) {
        appendTopologyConfigIssues(issues, effective);
    }
    return issues;
}

function appendTopologyConfigIssues(
    issues: TopologyConfigMutationValidationIssue[],
    config: ReturnType<typeof resolveDefaultGroupTopologyConfig>
): void {
    const configIssues = validateEffectiveGroupTopologyConfig(config);
    if (configIssues.length > 0) {
        const cause = new GroupTopologyConfigValidationError(configIssues);
        for (const issue of configIssues) {
            issues.push({
                ...issue,
                path: issue.path ?? [],
                cause
            });
        }
    }
}
