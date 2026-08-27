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

/**
 * The total mode-by-operation capability matrix (plan decision I19): each
 * internal producer holds exactly the operations it needs, every cross-product
 * outside the table fails closed, and the three modes whose operations arrive
 * in later slices admit nothing until those operations exist.
 */
function validateInternalMutationAuthority(
    command: GroupMutationCommand,
    facts: GroupMutationFacts
): void {
    if (facts.authenticatedAuthority !== null) {
        throw new TypeError('Internal group mutation cannot use authenticated authority facts');
    }
    if (command.input.actorPrincipalId !== null || command.input.actorSessionId !== null) {
        throw new TypeError('Internal group maintenance cannot claim semantic actor authority');
    }
    switch (facts.internalAuthority) {
        case 'formation-criterion':
            return validateFormationCriterionAuthority(command);
        case 'expiry':
            if (command.operation !== 'disconnectPresence' || command.input.reason !== 'expired') {
                throw new TypeError('Group expiry authority requires an expiry command');
            }
            return;
        case 'session-cleanup':
            if (command.operation !== 'disconnectPresence' || command.input.reason !== null) {
                throw new TypeError('Group session cleanup authority has invalid command facts');
            }
            return;
        case 'formation-automation':
            throw new TypeError(
                'Formation-automation authority is limited to automatic stage commands, none of which exist yet'
            );
        case 'topology-publication':
            throw new TypeError(
                'Topology-publication authority is limited to applyPlannedLayout, which does not exist yet'
            );
        case 'activation-status':
            throw new TypeError(
                'Activation-status authority is limited to the status update, which does not exist yet'
            );
        case 'none':
            throw new TypeError('Internal group mutation cannot carry the none authority mode');
    }
}

function validateFormationCriterionAuthority(command: GroupMutationCommand): void {
    switch (command.operation) {
        case 'startGroupEstablishment':
            if (command.input.expectedFormationEpoch === null) {
                throw new TypeError('Criterion transitions must carry the expected formation epoch fence');
            }
            return;
        case 'activateGroup':
        case 'failGroupFormation':
            if (command.input.expectedFormationEpoch === null) {
                throw new TypeError('Criterion transitions must carry the expected formation epoch fence');
            }
            if (command.input.observedRate === null) {
                throw new TypeError('Criterion transitions must carry the observed rate');
            }
            if (command.input.expectedLayout === null) {
                throw new TypeError('Criterion transitions must carry the expected layout fence');
            }
            return;
        default:
            throw new TypeError('Formation-criterion authority is limited to criterion transitions');
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
