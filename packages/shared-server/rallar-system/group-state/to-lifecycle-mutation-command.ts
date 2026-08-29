import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupTopologyReconfigureLanding } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { MutationActorInput } from '@shared/api/state-types.ts';

import { toGroupMutationActorInput, toGroupMutationIdentity } from './group-mutation-command.ts';
import type { GroupMutationDescriptor } from './group-state-service-contracts.ts';
import type { GroupMutationCommand } from './mutation/group-mutation-contracts.ts';

export function toLifecycleMutationCommand(
    descriptor: GroupMutationDescriptor,
    randomId: () => string
): GroupMutationCommand {
    switch (descriptor.operation) {
        case 'startGroupEstablishment':
        case 'reopenGroupEstablishment':
        case 'planGroupLayout':
        case 'startGroupFormation':
            return toTransitionCommand(descriptor.operation, descriptor, randomId);
        case 'reconfigureGroup':
            return toReconfigureCommand(descriptor, randomId);
        case 'activateGroup':
            return toActivateCommand(descriptor, randomId);
        case 'connectGroup':
            return toConnectCommand(descriptor, randomId);
        case 'failGroupFormation':
            return toFailFormationCommand(descriptor, randomId);
        default:
            throw new TypeError(`Unsupported lifecycle group mutation: ${descriptor.operation}`);
    }
}

function toReconfigureCommand(
    descriptor: GroupMutationDescriptor,
    randomId: () => string
): GroupMutationCommand {
    const request = descriptor.request as MutationActorInput & Readonly<{
        landing?: GroupTopologyReconfigureLanding | null;
    }>;
    return {
        operation: 'reconfigureGroup',
        aggregateRef: { ...descriptor.scope, groupId: descriptor.groupId },
        ...toGroupMutationIdentity(request.requestId, randomId),
        input: {
            ...toGroupMutationActorInput(request),
            expectedFormationEpoch: null,
            landing: request.landing ?? null
        }
    };
}

function toTransitionCommand(
    operation:
        | 'startGroupEstablishment'
        | 'reopenGroupEstablishment'
        | 'planGroupLayout'
        | 'startGroupFormation',
    descriptor: GroupMutationDescriptor,
    randomId: () => string
): GroupMutationCommand {
    const request = descriptor.request as MutationActorInput;
    return {
        operation,
        aggregateRef: { ...descriptor.scope, groupId: descriptor.groupId },
        ...toGroupMutationIdentity(request.requestId, randomId),
        input: {
            ...toGroupMutationActorInput(request),
            expectedFormationEpoch: null
        }
    };
}

function toConnectCommand(
    descriptor: GroupMutationDescriptor,
    randomId: () => string
): GroupMutationCommand {
    const request = descriptor.request as
        & MutationActorInput
        & Readonly<{
            expectedFormationEpoch?: number | null;
            expectedLayout?: GroupLayoutIdentity | null;
        }>;
    // `connect` names the exact planned layout it dials (product decision
    // 32); absent and null are equally malformed here, so neither can reach
    // a field the command contract types non-null.
    if (
        request.expectedFormationEpoch === undefined || request.expectedFormationEpoch === null ||
        request.expectedLayout === undefined || request.expectedLayout === null
    ) {
        throw new TypeError('Group connect requires expectedFormationEpoch and expectedLayout');
    }
    return {
        operation: 'connectGroup',
        aggregateRef: { ...descriptor.scope, groupId: descriptor.groupId },
        ...toGroupMutationIdentity(request.requestId, randomId),
        input: {
            ...toGroupMutationActorInput(request),
            expectedFormationEpoch: request.expectedFormationEpoch,
            expectedLayout: request.expectedLayout
        }
    };
}

function toActivateCommand(
    descriptor: GroupMutationDescriptor,
    randomId: () => string
): GroupMutationCommand {
    const request = descriptor.request as
        & MutationActorInput
        & Readonly<{ observedRate?: number; degraded?: boolean; }>;
    return {
        operation: 'activateGroup',
        aggregateRef: { ...descriptor.scope, groupId: descriptor.groupId },
        ...toGroupMutationIdentity(request.requestId, randomId),
        input: {
            ...toGroupMutationActorInput(request),
            observedRate: request.observedRate ?? null,
            degraded: request.degraded ?? null,
            expectedFormationEpoch: null,
            expectedLayout: null
        }
    };
}

function toFailFormationCommand(
    descriptor: GroupMutationDescriptor,
    randomId: () => string
): GroupMutationCommand {
    const request = descriptor.request as MutationActorInput & Readonly<{ observedRate: number; }>;
    return {
        operation: 'failGroupFormation',
        aggregateRef: { ...descriptor.scope, groupId: descriptor.groupId },
        ...toGroupMutationIdentity(request.requestId, randomId),
        input: {
            ...toGroupMutationActorInput(request),
            observedRate: request.observedRate,
            expectedFormationEpoch: null,
            expectedLayout: null
        }
    };
}
