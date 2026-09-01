import type { GroupMutationCommand, GroupMutationFacts } from '../group-mutation-contracts.ts';

export function assertGroupMutationJoinCodeFacts(
    command: GroupMutationCommand,
    facts: GroupMutationFacts
): void {
    if (command.operation === 'rotateGroupJoinCode') {
        if (facts.resolvedJoinCode === null || facts.joinCodeVerifier === null) {
            throw new TypeError('Group rotate mutation is missing its generated join code facts');
        }
        if (command.input.joinCode !== null && facts.resolvedJoinCode !== command.input.joinCode) {
            throw new TypeError('Group rotate resolved join code differs from explicit command intent');
        }
        return;
    }
    if (command.operation === 'joinGroup' || command.operation === 'acceptGroupInvite') {
        if (facts.resolvedJoinCode !== command.input.joinCode) {
            throw new TypeError('Group resolved join code differs from join command intent');
        }
        return;
    }
    if (facts.resolvedJoinCode !== null || facts.joinCodeVerifier !== null) {
        throw new TypeError('Unrelated group operation contains resolved join code facts');
    }
}
