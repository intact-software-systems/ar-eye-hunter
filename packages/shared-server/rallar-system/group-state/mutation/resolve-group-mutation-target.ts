import type { GroupMutationCommand } from './group-mutation-contracts.ts';

export function mutationTargetPrincipalId(command: GroupMutationCommand): string | null {
  if ('targetPrincipalId' in command) return command.targetPrincipalId;
  if (command.operation === 'connectPresence') return command.input.principalId;
  if (command.operation === 'heartbeatPresence' || command.operation === 'disconnectPresence') {
    return command.input.principalId ?? command.input.actorPrincipalId;
  }
  return command.input.actorPrincipalId;
}

export function mutationTargetSessionId(command: GroupMutationCommand): string | null {
  if ('sessionId' in command) return command.sessionId;
  return command.operation === 'appointDirector' ? command.input.actorSessionId : null;
}
