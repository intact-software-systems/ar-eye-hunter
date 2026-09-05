import { canUpdateGroupSnapshot } from '../../../group-state/policy/group-governance-policy.ts';
import { canMutateActiveGroup } from '../../../group-state/policy/group-lifecycle-policy.ts';
import { GroupPolicyDeniedError } from '../../../group-state/policy/group-policy-result.ts';
import {
    GroupTopologyConfigValidationError,
    validateGroupTopologyConfigPatch
} from '../group-topology-config.ts';
import type {
    GroupTopologyConfigMutationCommand,
    GroupTopologyConfigMutationFacts,
    GroupTopologyConfigMutationRead,
    TopologyConfigMutationValidationIssue
} from './group-topology-config-mutation-contracts.ts';

export function validateTopologyConfigMutationPolicy(
    command: GroupTopologyConfigMutationCommand,
    read: GroupTopologyConfigMutationRead,
    facts: GroupTopologyConfigMutationFacts
): readonly TopologyConfigMutationValidationIssue[] {
    const issues: TopologyConfigMutationValidationIssue[] = [];
    const isPut = command.operation === 'putConfig' || command.operation === 'putOverride';
    if (isPut && command.input.config !== null) {
        const configIssues = validateGroupTopologyConfigPatch(command.input.config);
        if (configIssues.length > 0) {
            const cause = new GroupTopologyConfigValidationError(configIssues);
            for (const issue of configIssues) {
                issues.push({ ...issue, path: issue.path ?? [], cause });
            }
        }
    }
    if (
        command.operation === 'putOverride' &&
        facts.resolvedOverrideExpiresAtEpochMs !== null &&
        facts.resolvedOverrideExpiresAtEpochMs <= facts.policyNowEpochMs
    ) {
        const path = command.input.expiresAtEpochMs === null ? ['ttlMs'] : ['expiresAtEpochMs'];
        const configIssue = {
            code: 'override-expiry-not-in-future',
            path,
            message: 'Temporary topology override expiry must be in the future'
        } as const;
        issues.push({
            ...configIssue,
            cause: new GroupTopologyConfigValidationError([configIssue])
        });
    }

    const lifecyclePolicy = canMutateActiveGroup({
        group: read.groupSnapshot.group,
        nowEpochMs: facts.policyNowEpochMs
    });
    if (!lifecyclePolicy.allowed) {
        issues.push({
            code: lifecyclePolicy.code,
            path: ['read', 'groupSnapshot', 'group'],
            message: lifecyclePolicy.message,
            cause: new GroupPolicyDeniedError(lifecyclePolicy)
        });
    }
    if (lifecyclePolicy.allowed && !facts.isPlatformAdmin) {
        const governancePolicy = canUpdateGroupSnapshot({
            snapshot: read.groupSnapshot,
            actor: { principalId: command.input.updatedByPrincipalId },
            nowEpochMs: facts.policyNowEpochMs
        });
        if (!governancePolicy.allowed) {
            issues.push({
                code: governancePolicy.code,
                path: ['command', 'input', 'updatedByPrincipalId'],
                message: governancePolicy.message,
                cause: new GroupPolicyDeniedError(governancePolicy)
            });
        }
    }
    return issues;
}
