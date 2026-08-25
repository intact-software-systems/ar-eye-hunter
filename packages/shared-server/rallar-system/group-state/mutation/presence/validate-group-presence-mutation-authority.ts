import { assertPrincipalAuthority } from '../aggregate/group-aggregate-mutation-policy.ts';
import type { GroupMutationCommand, GroupMutationFacts } from '../group-mutation-contracts.ts';

export function validateGroupPresenceMutationAuthority(
    command: GroupMutationCommand,
    principalId: string,
    facts: GroupMutationFacts
): void {
    if (facts.internalAuthority !== 'none') {
        return;
    }
    assertPrincipalAuthority(command, principalId);
}
