import {
    DEFAULT_RALLAR_GROUP_DIRECTOR_HEARTBEAT_TTL_MS,
    normalizeRallarGroupDirectorHeartbeatTtlMs
} from '@shared/api/group-director.ts';
import { toNormalizedGroupLifecyclePolicy } from '@shared/api/group-lifecycle/to-normalized-group-lifecycle-policy.ts';
import { GROUP_RETENTION_METADATA_KEY, toInitialGroupRetentionState } from '@shared/api/group-retention.ts';
import type {
    CreateGroupRequest,
    JoinGroupRequest,
    MutationActorInput,
    StateScope
} from '@shared/api/state-types.ts';
import { NonRetryableException } from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';

import type { GroupMutationDescriptor } from './group-state-service-contracts.ts';
import type { GroupMutationCommand } from './mutation/group-mutation-contracts.ts';

export interface GroupMutationIdentity {
    readonly commandId: string;
    readonly requestId: string | null;
}

export interface GroupMutationActorInput {
    readonly actorPrincipalId: string | null;
    readonly actorSessionId: string | null;
    readonly reason: string | null;
}

export function toAggregateMutationCommand(
    descriptor: GroupMutationDescriptor,
    randomId: () => string
): GroupMutationCommand {
    switch (descriptor.operation) {
        case 'createGroup': {
            const request = descriptor.request;
            if (request.groupId !== descriptor.groupId) {
                throw new NonRetryableException('Group create identity is inconsistent');
            }
            return toCreateCommand(descriptor.scope, request, randomId);
        }
        case 'updateGroup':
            return toUpdateCommand(descriptor, randomId);
        case 'appointDirector':
            return toDirectorCommand(descriptor, randomId);
        case 'rotateGroupJoinCode':
            return toRotateCommand(descriptor, randomId);
        default:
            throw new TypeError(`Unsupported aggregate group mutation: ${descriptor.operation}`);
    }
}

export function toMembershipMutationCommand(
    descriptor: GroupMutationDescriptor,
    randomId: () => string
): GroupMutationCommand {
    switch (descriptor.operation) {
        case 'joinGroup':
        case 'acceptGroupInvite':
            return toJoinCommand(descriptor, randomId);
        case 'createGroupInvite':
            return toInviteCommand(descriptor, randomId);
        case 'revokeGroupInvite':
        case 'removeGroupMember':
        case 'banGroupMember':
        case 'unbanGroupMember':
        case 'grantGroupAdmission':
        case 'declineGroupAdmission':
            return toTargetCommand(descriptor, randomId);
        case 'setGroupMemberRole':
            return toRoleCommand(descriptor, randomId);
        case 'transferGroupOwnership':
            return toTransferCommand(descriptor, randomId);
        case 'upsertMember':
            return toUpsertMemberCommand(descriptor, randomId);
        default:
            throw new TypeError(`Unsupported membership group mutation: ${descriptor.operation}`);
    }
}

function requireTargetPrincipalId(descriptor: GroupMutationDescriptor): string {
    if (!descriptor.targetPrincipalId) {
        throw new NonRetryableException('Group mutation target principal is required');
    }
    return descriptor.targetPrincipalId;
}

function toCreateCommand(
    scope: StateScope,
    request: CreateGroupRequest,
    randomId: () => string
): GroupMutationCommand {
    const commandId = request.requestId ?? randomId();
    const retention = toInitialGroupRetentionState(request.retention);
    return {
        operation: 'createGroup',
        aggregateRef: { ...scope, groupId: request.groupId },
        commandId,
        requestId: request.requestId ?? commandId,
        input: {
            slug: request.slug ?? null,
            displayName: request.displayName,
            description: request.description ?? null,
            kind: request.kind,
            joinMode: request.joinMode ?? 'invite-only',
            ...(request.directoryListing === undefined ? {} : { directoryListing: request.directoryListing }),
            ...(request.lifecyclePolicy === undefined
                ? {}
                : { lifecyclePolicy: toNormalizedGroupLifecyclePolicy(request.lifecyclePolicy) }),
            maxMembers: request.maxMembers ?? null,
            maxSessionsPerMember: request.maxSessionsPerMember ?? null,
            metadata: {
                ...structuredClone(request.metadata ?? {}),
                ...(retention === null ? {} : { [GROUP_RETENTION_METADATA_KEY]: { ...retention } })
            },
            createdByPrincipalId: request.createdByPrincipalId,
            expiresAtEpochMs: request.expiresAtEpochMs ?? null,
            purgeAfterEpochMs: request.purgeAfterEpochMs ?? null,
            ...toGroupMutationActorInput(request),
            actorPrincipalId: request.actorPrincipalId ?? request.createdByPrincipalId
        }
    };
}

function toUpdateCommand(
    descriptor: Extract<GroupMutationDescriptor, { operation: 'updateGroup'; }>,
    randomId: () => string
): GroupMutationCommand {
    const request = descriptor.request;
    return {
        operation: 'updateGroup',
        aggregateRef: { ...descriptor.scope, groupId: descriptor.groupId },
        ...toGroupMutationIdentity(request.requestId, randomId),
        input: {
            slug: request.slug ?? null,
            displayName: request.displayName ?? null,
            description: request.description ?? null,
            kind: request.kind ?? null,
            status: request.status ?? null,
            joinMode: request.joinMode ?? null,
            ...(request.directoryListing === undefined ? {} : { directoryListing: request.directoryListing }),
            maxMembers: request.maxMembers ?? null,
            maxSessionsPerMember: request.maxSessionsPerMember ?? null,
            metadata: request.metadata ? structuredClone(request.metadata) : null,
            expiresAtEpochMs: request.expiresAtEpochMs ?? null,
            emptySinceEpochMs: request.emptySinceEpochMs ?? null,
            purgeAfterEpochMs: request.purgeAfterEpochMs ?? null,
            ...toGroupMutationActorInput(request)
        }
    };
}

function toDirectorCommand(
    descriptor: Extract<GroupMutationDescriptor, { operation: 'appointDirector'; }>,
    randomId: () => string
): GroupMutationCommand {
    const request = descriptor.request;
    return {
        operation: 'appointDirector',
        aggregateRef: { ...descriptor.scope, groupId: descriptor.groupId },
        ...toGroupMutationIdentity(request.requestId, randomId),
        input: {
            heartbeatTtlMs: normalizeRallarGroupDirectorHeartbeatTtlMs(
                request.heartbeatTtlMs ?? DEFAULT_RALLAR_GROUP_DIRECTOR_HEARTBEAT_TTL_MS
            ),
            ...toGroupMutationActorInput(request)
        }
    };
}

function toJoinCommand(
    descriptor: Extract<GroupMutationDescriptor, { operation: 'joinGroup' | 'acceptGroupInvite'; }>,
    randomId: () => string
): GroupMutationCommand {
    const request: JoinGroupRequest = descriptor.request;
    if (!request.actorPrincipalId) {
        throw new NonRetryableException('Forbidden: Cannot join a group without a principal.');
    }
    return {
        operation: descriptor.operation,
        aggregateRef: { ...descriptor.scope, groupId: descriptor.groupId },
        targetPrincipalId: request.actorPrincipalId,
        ...toGroupMutationIdentity(request.requestId, randomId),
        input: {
            inviteToken: request.inviteToken ?? null,
            joinCode: request.joinCode ? normalizeJoinCode(request.joinCode) : null,
            ...toGroupMutationActorInput(request)
        }
    };
}

function toInviteCommand(
    descriptor: Extract<GroupMutationDescriptor, { operation: 'createGroupInvite'; }>,
    randomId: () => string
): GroupMutationCommand {
    const request = descriptor.request;
    return {
        operation: 'createGroupInvite',
        aggregateRef: { ...descriptor.scope, groupId: descriptor.groupId },
        targetPrincipalId: requireTargetPrincipalId(descriptor),
        ...toGroupMutationIdentity(request.requestId, randomId),
        input: {
            invitationExpiresAtEpochMs: request.invitationExpiresAtEpochMs ?? null,
            ...toGroupMutationActorInput(request)
        }
    };
}

function toTargetCommand(
    descriptor: Extract<GroupMutationDescriptor, {
        operation:
            | 'revokeGroupInvite'
            | 'removeGroupMember'
            | 'banGroupMember'
            | 'unbanGroupMember'
            | 'grantGroupAdmission'
            | 'declineGroupAdmission';
    }>,
    randomId: () => string
): GroupMutationCommand {
    const request = descriptor.request;
    return {
        operation: descriptor.operation,
        aggregateRef: { ...descriptor.scope, groupId: descriptor.groupId },
        targetPrincipalId: requireTargetPrincipalId(descriptor),
        ...toGroupMutationIdentity(request.requestId, randomId),
        input: toGroupMutationActorInput(request)
    };
}

function toRoleCommand(
    descriptor: Extract<GroupMutationDescriptor, { operation: 'setGroupMemberRole'; }>,
    randomId: () => string
): GroupMutationCommand {
    const request = descriptor.request;
    return {
        operation: 'setGroupMemberRole',
        aggregateRef: { ...descriptor.scope, groupId: descriptor.groupId },
        targetPrincipalId: requireTargetPrincipalId(descriptor),
        ...toGroupMutationIdentity(request.requestId, randomId),
        input: { role: request.role, ...toGroupMutationActorInput(request) }
    };
}

function toTransferCommand(
    descriptor: Extract<GroupMutationDescriptor, { operation: 'transferGroupOwnership'; }>,
    randomId: () => string
): GroupMutationCommand {
    const request = descriptor.request;
    if (descriptor.targetPrincipalId !== request.newOwnerPrincipalId) {
        throw new NonRetryableException('Ownership target identity is inconsistent');
    }
    return {
        operation: 'transferGroupOwnership',
        aggregateRef: { ...descriptor.scope, groupId: descriptor.groupId },
        targetPrincipalId: request.newOwnerPrincipalId,
        ...toGroupMutationIdentity(request.requestId, randomId),
        input: toGroupMutationActorInput(request)
    };
}

function toUpsertMemberCommand(
    descriptor: Extract<GroupMutationDescriptor, { operation: 'upsertMember'; }>,
    randomId: () => string
): GroupMutationCommand {
    const request = descriptor.request;
    return {
        operation: 'upsertMember',
        aggregateRef: { ...descriptor.scope, groupId: descriptor.groupId },
        targetPrincipalId: requireTargetPrincipalId(descriptor),
        ...toGroupMutationIdentity(request.requestId, randomId),
        input: {
            role: request.role ?? null,
            status: request.status,
            invitedByPrincipalId: request.invitedByPrincipalId ?? null,
            invitationExpiresAtEpochMs: request.invitationExpiresAtEpochMs ?? null,
            ...toGroupMutationActorInput(request)
        }
    };
}

function toRotateCommand(
    descriptor: Extract<GroupMutationDescriptor, { operation: 'rotateGroupJoinCode'; }>,
    randomId: () => string
): GroupMutationCommand {
    const request = descriptor.request;
    return {
        operation: 'rotateGroupJoinCode',
        aggregateRef: { ...descriptor.scope, groupId: descriptor.groupId },
        ...toGroupMutationIdentity(request.requestId, randomId),
        input: {
            joinCode: request.joinCode === undefined ? null : normalizeJoinCode(request.joinCode),
            expiresAtEpochMs: request.expiresAtEpochMs ?? null,
            ...toGroupMutationActorInput(request)
        }
    };
}

export function toGroupMutationIdentity(
    requestId: string | undefined,
    randomId: () => string
): GroupMutationIdentity {
    const commandId = requestId ?? randomId();
    return { commandId, requestId: requestId ?? null };
}

export function toGroupMutationActorInput(
    request: Pick<MutationActorInput, 'actorPrincipalId' | 'actorSessionId' | 'reason'>
): GroupMutationActorInput {
    return {
        actorPrincipalId: request.actorPrincipalId ?? null,
        actorSessionId: request.actorSessionId ?? null,
        reason: request.reason ?? null
    };
}

function normalizeJoinCode(value: string): string {
    const normalized = value
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/gu, '')
        .slice(0, 12);
    if (normalized.length < 4) {
        throw new NonRetryableException('Group join code must contain at least four characters');
    }
    return normalized;
}
