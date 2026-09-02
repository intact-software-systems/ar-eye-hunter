import {
    validateAppInboxComputedData,
    validateAppInboxComputedProjection
} from '../../../app-inbox/handler/app-inbox-computed-validation.ts';
import { type GroupStateValidationIssue } from '../../group-state-validation-issues.ts';
import { GroupPolicyDeniedError } from '../../policy/group-policy-result.ts';
import { validateGroupAggregateMutationPolicy } from '../aggregate/group-aggregate-mutation-policy.ts';
import { validateGroupMutationAuthority } from '../command-validation/validate-group-mutation-authority.ts';
import { validateGroupMutationCommand } from '../command-validation/validate-group-mutation-command.ts';
import { type GroupMutationComputed } from '../group-mutation-contracts.ts';
import { toGroupMutationRejectionError } from '../group-mutation-result.ts';
import { validateGroupMembershipMutationPolicy } from '../membership/group-membership-mutation-policy.ts';
import { computeGroupMutationDecision } from '../orchestration/compute-group-mutation.ts';
import {
    validateComputedGroupMutation,
    type ValidateComputedGroupMutationInput
} from '../result-validation/validate-computed-group-mutation.ts';
import { validateGroupMutationFacts } from './validate-group-mutation-facts.ts';
import { validateGroupMutationRead } from './validate-group-mutation-read.ts';

export function validateGroupMutation(input: ValidateComputedGroupMutationInput): readonly GroupStateValidationIssue[] {
    const commandIssues = validateGroupMutationCommand(input.command);
    const factIssues = validateGroupMutationFacts(input.facts);
    const readIssues = commandIssues.length === 0 ? validateGroupMutationRead(input.read, input.command) : [];
    const issues = [...commandIssues, ...readIssues, ...factIssues];
    if (commandIssues.length === 0 && factIssues.length === 0) {
        issues.push(...validateGroupMutationAuthority(input.command, input.facts));
    }
    const computed = input.computed;
    issues.push(...validateAppInboxComputedData(computed, 'computed'));
    if (issues.length > 0) {
        return issues;
    }
    issues.push(...validateComputedGroupMutation(input));
    const policyIssues = [
        ...validateGroupAggregateMutationPolicy(input.command, input.read, input.facts),
        ...validateGroupMembershipMutationPolicy(input.command, input.read, input.facts)
    ];
    if (policyIssues.length > 0) {
        return matchesComputedRejection(input.computed, policyIssues[0].cause)
            ? issues
            : [...issues, ...policyIssues];
    }
    const canonical = computeGroupMutationDecision({
        command: input.command,
        read: input.read,
        facts: input.facts
    });
    if (canonical.left !== undefined) {
        if (canonical.left.length === 1 && matchesComputedRejection(input.computed, canonical.left[0].cause)) {
            return issues;
        }
        return [...issues, ...canonical.left];
    }
    issues.push(...validateAppInboxComputedProjection(canonical.right, computed, 'computed'));
    return issues;
}

function matchesComputedRejection(computed: GroupMutationComputed, expected: Error): boolean {
    if (computed.outcome !== 'rejected') {
        return false;
    }
    const actual = toGroupMutationRejectionError(computed);
    if (actual.name !== expected.name || actual.message !== expected.message) {
        return false;
    }
    if (actual instanceof GroupPolicyDeniedError && expected instanceof GroupPolicyDeniedError) {
        return validateAppInboxComputedProjection(expected.denial, actual.denial, 'computed.policyDenial').length === 0;
    }
    return 'code' in actual && 'code' in expected && actual.code === expected.code;
}
