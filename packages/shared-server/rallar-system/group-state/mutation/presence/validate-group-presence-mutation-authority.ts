import type { GroupStateValidationIssue } from '../../group-state-validation-issues.ts';
import { validatePrincipalAuthority } from '../aggregate/group-aggregate-mutation-policy.ts';
import type { GroupMutationCommand, GroupMutationFacts } from '../group-mutation-contracts.ts';

export function validateGroupPresenceMutationAuthority(
    command: GroupMutationCommand,
    principalId: string,
    facts: GroupMutationFacts
): readonly GroupStateValidationIssue[] {
    if (facts.internalAuthority !== 'none') {
        return [];
    }
    return validatePrincipalAuthority(command, principalId);
}
