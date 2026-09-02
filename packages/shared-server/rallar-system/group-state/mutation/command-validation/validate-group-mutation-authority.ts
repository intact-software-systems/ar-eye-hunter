import { toGroupStateValidationIssue, type GroupStateValidationIssue } from '../../group-state-validation-issues.ts';
import type { GroupMutationCommand, GroupMutationFacts } from '../group-mutation-contracts.ts';

export function validateGroupMutationAuthority(
    command: GroupMutationCommand,
    facts: GroupMutationFacts
): readonly GroupStateValidationIssue[] {
    const issues = [...validateResolvedJoinCodeFacts(command, facts)];
    const authority = facts.authenticatedAuthority;
    if (facts.internalAuthority !== 'none') {
        return [...issues, ...validateInternalMutationAuthority(command, facts)];
    }
    if (authority === null) {
        return [
            ...issues,
            toGroupStateValidationIssue(
                'facts.authenticatedAuthority',
                'User group mutation requires authenticated authority facts'
            )
        ];
    }
    if (!authority) {
        return [
            ...issues,
            toGroupStateValidationIssue(
                'facts.authenticatedAuthority',
                'Authenticated group mutation authority is missing'
            )
        ];
    }
    if (
        command.input.actorPrincipalId !== authority.principalId ||
        command.input.actorSessionId !== authority.sessionId
    ) {
        issues.push(toGroupStateValidationIssue(
            'command.input',
            'Group mutation actor differs from authenticated authority'
        ));
    }
    if (command.operation === 'connectGroup' && command.input.connectTriggerGeneration !== null) {
        issues.push(toGroupStateValidationIssue(
            'command.input.connectTriggerGeneration',
            'Principal connect cannot consume automatic trigger intent'
        ));
    }
    return issues;
}

function validateInternalMutationAuthority(
    command: GroupMutationCommand,
    facts: GroupMutationFacts
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    if (facts.authenticatedAuthority !== null) {
        issues.push(toGroupStateValidationIssue(
            'facts.authenticatedAuthority',
            'Internal group mutation cannot use authenticated authority facts'
        ));
    }
    if (command.input.actorPrincipalId !== null || command.input.actorSessionId !== null) {
        issues.push(toGroupStateValidationIssue(
            'command.input',
            'Internal group maintenance cannot claim semantic actor authority'
        ));
    }
    return [...issues, ...validateInternalOperationCapability(command, facts.internalAuthority)];
}

/** Each internal producer owns only the operations explicitly admitted here. */
function validateInternalOperationCapability(
    command: GroupMutationCommand,
    internalAuthority: GroupMutationFacts['internalAuthority']
): readonly GroupStateValidationIssue[] {
    switch (internalAuthority) {
        case 'formation-criterion':
            return validateFormationCriterionAuthority(command);
        case 'expiry':
            return command.operation === 'disconnectPresence' && command.input.reason === 'expired'
                ? []
                : [toGroupStateValidationIssue('command', 'Group expiry authority requires an expiry command')];
        case 'session-cleanup':
            return command.operation === 'disconnectPresence' && command.input.reason === null
                ? []
                : [toGroupStateValidationIssue('command', 'Group session cleanup authority has invalid command facts')];
        case 'formation-automation':
            return validateFormationAutomationAuthority(command);
        case 'topology-publication':
            return validateTopologyPublicationAuthority(command);
        case 'activation-status':
            return [toGroupStateValidationIssue(
                'facts.internalAuthority',
                'Activation-status authority is limited to the status update, which does not exist yet'
            )];
        case 'none':
            return [toGroupStateValidationIssue(
                'facts.internalAuthority',
                'Internal group mutation cannot carry the none authority mode'
            )];
        default: {
            const unhandled: never = internalAuthority;
            return [toGroupStateValidationIssue(
                'facts.internalAuthority',
                `Internal group mutation authority mode is unknown: ${String(unhandled)}`
            )];
        }
    }
}

function validateFormationAutomationAuthority(command: GroupMutationCommand): readonly GroupStateValidationIssue[] {
    if (command.operation !== 'planGroupLayout' && command.operation !== 'connectGroup') {
        return [toGroupStateValidationIssue(
            'command.operation',
            'Formation-automation authority is limited to automatic stage commands'
        )];
    }
    const issues: GroupStateValidationIssue[] = [];
    if (command.input.expectedFormationEpoch === null || command.input.expectedFormationEpoch === undefined) {
        issues.push(toGroupStateValidationIssue(
            'command.input.expectedFormationEpoch',
            'Formation automation requires an expected formation epoch'
        ));
    }
    if (command.operation === 'connectGroup' && !command.input.connectTriggerGeneration) {
        issues.push(toGroupStateValidationIssue(
            'command.input.connectTriggerGeneration',
            'Automatic connect requires a durable trigger identity'
        ));
    }
    return issues;
}

function validateFormationCriterionAuthority(command: GroupMutationCommand): readonly GroupStateValidationIssue[] {
    if (
        command.operation !== 'activateGroup' &&
        command.operation !== 'failGroupFormation'
    ) {
        return [toGroupStateValidationIssue(
            'command.operation',
            'Formation-criterion authority is limited to criterion transitions'
        )];
    }
    const issues: GroupStateValidationIssue[] = [];
    if (command.input.expectedFormationEpoch === null || command.input.expectedFormationEpoch === undefined) {
        issues.push(toGroupStateValidationIssue(
            'command.input.expectedFormationEpoch',
            'Criterion transitions must carry the expected formation epoch fence'
        ));
    }
    if (command.operation !== 'activateGroup' && command.operation !== 'failGroupFormation') {
        return issues;
    }
    if (command.input.observedRate === null || command.input.observedRate === undefined) {
        issues.push(
            toGroupStateValidationIssue(
                'command.input.observedRate',
                'Criterion transitions must carry the observed rate'
            )
        );
    }
    if (command.input.expectedLayout === null || command.input.expectedLayout === undefined) {
        issues.push(toGroupStateValidationIssue(
            'command.input.expectedLayout',
            'Criterion transitions must carry the expected layout fence'
        ));
    }
    return issues;
}

function validateTopologyPublicationAuthority(command: GroupMutationCommand): readonly GroupStateValidationIssue[] {
    if (command.operation !== 'applyPlannedLayout') {
        return [toGroupStateValidationIssue(
            'command.operation',
            'Topology-publication authority is limited to applyPlannedLayout'
        )];
    }
    const issues: GroupStateValidationIssue[] = [];
    if (command.input.expectedFormationEpoch === null || command.input.expectedFormationEpoch === undefined) {
        issues.push(toGroupStateValidationIssue(
            'command.input.expectedFormationEpoch',
            'Planned layout promotion must carry the expected formation epoch fence'
        ));
    }
    if (command.input.expectedLayout === null || command.input.expectedLayout === undefined) {
        issues.push(toGroupStateValidationIssue(
            'command.input.expectedLayout',
            'Planned layout promotion must carry the expected layout fence'
        ));
    }
    return issues;
}

function validateResolvedJoinCodeFacts(
    command: GroupMutationCommand,
    facts: GroupMutationFacts
): readonly GroupStateValidationIssue[] {
    if (command.operation === 'rotateGroupJoinCode') {
        const issues: GroupStateValidationIssue[] = [];
        if (facts.resolvedJoinCode === null || facts.joinCodeVerifier === null) {
            issues.push(toGroupStateValidationIssue(
                'facts.resolvedJoinCode',
                'Group rotate mutation is missing its generated join code facts'
            ));
        }
        if (command.input.joinCode !== null && facts.resolvedJoinCode !== command.input.joinCode) {
            issues.push(toGroupStateValidationIssue(
                'facts.resolvedJoinCode',
                'Group rotate resolved join code differs from explicit command intent'
            ));
        }
        return issues;
    }
    if (command.operation === 'joinGroup' || command.operation === 'acceptGroupInvite') {
        return facts.resolvedJoinCode === command.input.joinCode
            ? []
            : [toGroupStateValidationIssue(
                'facts.resolvedJoinCode',
                'Group resolved join code differs from join command intent'
            )];
    }
    return facts.resolvedJoinCode === null && facts.joinCodeVerifier === null
        ? []
        : [toGroupStateValidationIssue(
            'facts.resolvedJoinCode',
            'Unrelated group operation contains resolved join code facts'
        )];
}

