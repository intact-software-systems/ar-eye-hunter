import type { GroupMutationCommand, GroupMutationFacts } from '../group-mutation-contracts.ts';

export function validateGroupMutationAuthority(
    command: GroupMutationCommand,
    facts: GroupMutationFacts
): void {
    validateResolvedJoinCodeFacts(command, facts);
    const authority = facts.authenticatedAuthority;
    if (facts.internalAuthority === 'none' && authority === null) {
        throw new TypeError('User group mutation requires authenticated authority facts');
    }
    if (facts.internalAuthority !== 'none') {
        validateInternalMutationAuthority(command, facts);
        return;
    }
    if (!authority) {
        throw new TypeError('Authenticated group mutation authority is missing');
    }
    if (
        command.input.actorPrincipalId !== authority.principalId ||
        command.input.actorSessionId !== authority.sessionId
    ) {
        throw new TypeError('Group mutation actor differs from authenticated authority');
    }
}

function validateInternalMutationAuthority(
    command: GroupMutationCommand,
    facts: GroupMutationFacts
): void {
    if (facts.authenticatedAuthority !== null) {
        throw new TypeError('Internal group mutation cannot use authenticated authority facts');
    }
    if (facts.internalAuthority === 'formation-criterion') {
        validateFormationCriterionAuthority(command);
    }
    else if (command.operation !== 'disconnectPresence') {
        throw new TypeError('Internal group authority is limited to presence maintenance');
    }
    if (command.input.actorPrincipalId !== null || command.input.actorSessionId !== null) {
        throw new TypeError('Internal group maintenance cannot claim semantic actor authority');
    }
    if (facts.internalAuthority === 'expiry' && command.input.reason !== 'expired') {
        throw new TypeError('Group expiry authority requires an expiry command');
    }
    if (facts.internalAuthority === 'session-cleanup' && command.input.reason !== null) {
        throw new TypeError('Group session cleanup authority has invalid command facts');
    }
}

function validateFormationCriterionAuthority(command: GroupMutationCommand): void {
    if (
        command.operation !== 'activateGroup' &&
        command.operation !== 'failGroupFormation' &&
        command.operation !== 'startGroupEstablishment'
    ) {
        throw new TypeError('Formation-criterion authority is limited to criterion transitions');
    }
    if (
        (command.operation === 'activateGroup' || command.operation === 'failGroupFormation') &&
        command.input.observedRate === null
    ) {
        throw new TypeError('Criterion transitions must carry the observed rate');
    }
}

function validateResolvedJoinCodeFacts(
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
