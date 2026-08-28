import type { MutationActorInput } from '@shared/api/state-types.ts';

import { toGroupMutationActorInput, toGroupMutationIdentity } from './group-mutation-command.ts';
import type { GroupMutationDescriptor } from './group-state-service-contracts.ts';
import type { GroupMutationCommand, GroupTransportOperation } from './mutation/group-mutation-contracts.ts';

/**
 * The transport valve's builder (product decision 25). The direction is the
 * operation itself and the request carries nothing beyond actor identity, so
 * there is no fence to read and nothing to default.
 */
export function toTransportMutationCommand(
    descriptor: GroupMutationDescriptor,
    randomId: () => string
): GroupMutationCommand {
    const request = descriptor.request as MutationActorInput;
    return {
        operation: requireTransportOperation(descriptor.operation),
        aggregateRef: { ...descriptor.scope, groupId: descriptor.groupId },
        ...toGroupMutationIdentity(request.requestId, randomId),
        input: toGroupMutationActorInput(request)
    };
}

function requireTransportOperation(
    operation: GroupMutationDescriptor['operation']
): GroupTransportOperation {
    if (operation !== 'pauseGroupTransport' && operation !== 'resumeGroupTransport') {
        throw new TypeError(`Unsupported transport group mutation: ${operation}`);
    }
    return operation;
}
