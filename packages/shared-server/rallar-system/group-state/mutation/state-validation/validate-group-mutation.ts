import {
    validateAppInboxComputedData,
    validateAppInboxComputedProjection
} from '../../../app-inbox/handler/app-inbox-computed-validation.ts';
import { type GroupStateValidationIssue } from '../../group-state-validation-issues.ts';
import { validateGroupAggregateMutationPolicy } from '../aggregate/group-aggregate-mutation-policy.ts';
import { validateGroupMutationAuthority } from '../command-validation/validate-group-mutation-authority.ts';
import { validateGroupMutationCommand } from '../command-validation/validate-group-mutation-command.ts';
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
    issues.push(...validateGroupAggregateMutationPolicy(input.command, input.read, input.facts));
    issues.push(...validateGroupMembershipMutationPolicy(input.command, input.read, input.facts));
    if (issues.length > 0) {
        return issues;
    }
    const canonical = computeGroupMutationDecision({
        command: input.command,
        read: input.read,
        facts: input.facts
    });
    if (canonical.left !== undefined) {
        return [...issues, ...canonical.left];
    }
    issues.push(...validateAppInboxComputedProjection(canonical.right, computed, 'computed'));
    return issues;
}

