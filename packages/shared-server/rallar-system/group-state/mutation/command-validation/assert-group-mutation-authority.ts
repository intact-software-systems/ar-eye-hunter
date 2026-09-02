import type { GroupMutationCommand, GroupMutationFacts } from '../group-mutation-contracts.ts';
import { assertGroupMutationJoinCodeFacts } from './assert-group-mutation-join-code-facts.ts';

export function assertGroupMutationAuthority(
    command: GroupMutationCommand,
    facts: GroupMutationFacts
): void {
    assertGroupMutationJoinCodeFacts(command, facts);
    const authority = facts.authenticatedAuthority;
    if (facts.internalAuthority === 'none' && authority === null) {
        throw new TypeError('User group mutation requires authenticated authority facts');
    }
    if (facts.internalAuthority !== 'none') {
        assertInternalMutationAuthority(command, facts);
        return;
    }
    if (command.operation === 'connectGroup' && command.input.connectTriggerGeneration !== null) {
        throw new TypeError('Principal connect cannot consume automatic trigger intent');
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

// Internal producers hold only their own capability; reserved modes fail closed.
function assertInternalMutationAuthority(
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
            return assertFormationCriterionAuthority(command);
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
            return assertFormationAutomationAuthority(command);
        case 'topology-publication':
            return assertTopologyPublicationAuthority(command);
        case 'activation-status':
            throw new TypeError(
                'Activation-status authority is limited to the status update, which does not exist yet'
            );
        case 'none':
            throw new TypeError('Internal group mutation cannot carry the none authority mode');
        default: {
            // The compile-time anchor keeps the matrix total: an unhandled
            // future mode is a type error here, never a fail-open fallthrough.
            const unhandled: never = facts.internalAuthority;
            throw new TypeError(`Internal group mutation authority mode is unknown: ${String(unhandled)}`);
        }
    }
}

// The fence guards reject absent (`undefined`) alongside explicit null: a
// wire-decoded command lacking the keys is malformed here, not later as a
// lying stale-epoch rejection in compute.
function assertFormationCriterionAuthority(command: GroupMutationCommand): void {
    switch (command.operation) {
        case 'activateGroup':
        case 'failGroupFormation':
            if (command.input.expectedFormationEpoch === null || command.input.expectedFormationEpoch === undefined) {
                throw new TypeError('Criterion transitions must carry the expected formation epoch fence');
            }
            if (command.input.observedRate === null || command.input.observedRate === undefined) {
                throw new TypeError('Criterion transitions must carry the observed rate');
            }
            // A failed attempt may name no layout: the deadline fails a dialing
            // group whose planned layout is gone, and there is nothing to fence.
            if (
                command.input.expectedLayout === undefined ||
                (command.operation === 'activateGroup' && command.input.expectedLayout === null)
            ) {
                throw new TypeError('Criterion transitions must carry the expected layout fence');
            }
            return;
        default:
            throw new TypeError('Formation-criterion authority is limited to criterion transitions');
    }
}

function assertFormationAutomationAuthority(command: GroupMutationCommand): void {
    if (
        command.operation !== 'planGroupLayout' && command.operation !== 'connectGroup'
    ) {
        throw new TypeError('Formation-automation authority is limited to automatic stage commands');
    }
    if (command.input.expectedFormationEpoch === null || command.input.expectedFormationEpoch === undefined) {
        throw new TypeError('Formation automation requires an expected formation epoch');
    }
    if (command.operation === 'connectGroup' && !command.input.connectTriggerGeneration) {
        throw new TypeError('Automatic connect requires a durable trigger identity');
    }
}

function assertTopologyPublicationAuthority(command: GroupMutationCommand): void {
    if (command.operation !== 'applyPlannedLayout') {
        throw new TypeError('Topology-publication authority is limited to applyPlannedLayout');
    }
    // The contract types the fences non-null; the wire defense still rejects
    // an absent or null value a hand-built payload could carry.
    if (command.input.expectedFormationEpoch === null || command.input.expectedFormationEpoch === undefined) {
        throw new TypeError('Planned layout promotion must carry the expected formation epoch fence');
    }
    if (command.input.expectedLayout === null || command.input.expectedLayout === undefined) {
        throw new TypeError('Planned layout promotion must carry the expected layout fence');
    }
}
