import type { GroupMutationCommand } from '../group-mutation-contracts.ts';

export function resolveGroupMutationTargetPrincipalId(
    command: GroupMutationCommand
): string | null {
    if (command.operation === 'appointDirector') {
        const action = command.input.succession;
        if (action?.operation === 'appoint') return action.targetPrincipalId;
        if (action?.operation === 'configure' && action.deputyPrincipalId) return action.deputyPrincipalId;
    }
    if ('targetPrincipalId' in command) {
        return command.targetPrincipalId;
    }
    if (command.operation === 'createGroup') {
        return command.input.createdByPrincipalId;
    }
    if (command.operation === 'connectPresence') {
        return command.input.principalId;
    }
    if (command.operation === 'heartbeatPresence' || command.operation === 'disconnectPresence') {
        return command.input.principalId ?? command.input.actorPrincipalId;
    }
    return command.input.actorPrincipalId;
}

export function resolveGroupMutationTargetSessionId(command: GroupMutationCommand): string | null {
    if (command.operation === 'appointDirector') {
        const action = command.input.succession;
        if (action?.operation === 'appoint') return action.targetSessionId;
        if (action?.operation === 'configure' && action.deputyPrincipalId && action.deputyPrincipalId !== command.input.actorPrincipalId) return null;
    }
    if ('sessionId' in command) {
        return command.sessionId;
    }
    if (command.operation === 'appointDirector' ||
        (command.operation === 'updateGroup' && (command.input.roomClock !== undefined || command.input.roomDeadline?.expectedDirectorEpoch !== undefined))) {
        return command.input.actorSessionId;
    }
    return null;
}
