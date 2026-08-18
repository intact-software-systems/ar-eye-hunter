import type { MutationActorInput } from '@shared/api/state-types.ts';

import type { GroupMutationCommand } from './mutation/group-mutation-contracts.ts';
import type { GroupMutationDescriptor } from './group-state-service-contracts.ts';
import { toGroupMutationActorInput, toGroupMutationIdentity } from './group-mutation-command.ts';

export function toLifecycleMutationCommand(
  descriptor: GroupMutationDescriptor,
  randomId: () => string,
): GroupMutationCommand {
  switch (descriptor.operation) {
    case 'startGroupEstablishment':
    case 'reopenGroupEstablishment':
      return toTransitionCommand(descriptor.operation, descriptor, randomId);
    case 'activateGroup':
      return toActivateCommand(descriptor, randomId);
    case 'failGroupFormation':
      return toFailFormationCommand(descriptor, randomId);
    default:
      throw new TypeError(`Unsupported lifecycle group mutation: ${descriptor.operation}`);
  }
}

function toTransitionCommand(
  operation: 'startGroupEstablishment' | 'reopenGroupEstablishment',
  descriptor: GroupMutationDescriptor,
  randomId: () => string,
): GroupMutationCommand {
  const request = descriptor.request as MutationActorInput;
  return {
    operation,
    aggregateRef: { ...descriptor.scope, groupId: descriptor.groupId },
    ...toGroupMutationIdentity(request.requestId, randomId),
    input: toGroupMutationActorInput(request),
  };
}

function toActivateCommand(
  descriptor: GroupMutationDescriptor,
  randomId: () => string,
): GroupMutationCommand {
  const request = descriptor.request as MutationActorInput &
    Readonly<{ observedRate?: number; degraded?: boolean }>;
  return {
    operation: 'activateGroup',
    aggregateRef: { ...descriptor.scope, groupId: descriptor.groupId },
    ...toGroupMutationIdentity(request.requestId, randomId),
    input: {
      ...toGroupMutationActorInput(request),
      observedRate: request.observedRate ?? null,
      degraded: request.degraded ?? null,
    },
  };
}

function toFailFormationCommand(
  descriptor: GroupMutationDescriptor,
  randomId: () => string,
): GroupMutationCommand {
  const request = descriptor.request as MutationActorInput & Readonly<{ observedRate: number }>;
  return {
    operation: 'failGroupFormation',
    aggregateRef: { ...descriptor.scope, groupId: descriptor.groupId },
    ...toGroupMutationIdentity(request.requestId, randomId),
    input: {
      ...toGroupMutationActorInput(request),
      observedRate: request.observedRate,
    },
  };
}
