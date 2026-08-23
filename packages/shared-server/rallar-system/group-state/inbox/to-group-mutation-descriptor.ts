import { AppInboxType } from '../../app-inbox/app-inbox-queue-client.ts';
import { GroupMutationAuthorizationError, mutationDescriptor } from '../group-mutation-authority.ts';
import type { GroupMutationDescriptor } from '../group-state-service-contracts.ts';
import type { GroupMutationCommand } from '../mutation/group-mutation-contracts.ts';
import { type AuthenticatedGroupMutationEnqueue } from './group-state-inbox-contracts.ts';

export function toGroupMutationDescriptor(
    enqueue: AuthenticatedGroupMutationEnqueue
): GroupMutationDescriptor {
    switch (enqueue.type) {
        case AppInboxType.GROUP_CREATE:
        case AppInboxType.GROUP_UPDATE:
        case AppInboxType.GROUP_DIRECTOR_APPOINT:
        case AppInboxType.GROUP_ESTABLISHMENT_START:
        case AppInboxType.GROUP_ACTIVATE:
        case AppInboxType.GROUP_ESTABLISHMENT_REOPEN:
        case AppInboxType.GROUP_JOIN_CODE_ROTATE:
            return toAggregateMutationDescriptor(enqueue);
        case AppInboxType.GROUP_JOIN:
        case AppInboxType.GROUP_INVITE_CREATE:
        case AppInboxType.GROUP_INVITE_REVOKE:
        case AppInboxType.GROUP_INVITE_ACCEPT:
        case AppInboxType.GROUP_ADMISSION_GRANT:
        case AppInboxType.GROUP_ADMISSION_DECLINE:
            return toAdmissionMutationDescriptor(enqueue);
        case AppInboxType.GROUP_MEMBER_REMOVE:
        case AppInboxType.GROUP_MEMBER_BAN:
        case AppInboxType.GROUP_MEMBER_UNBAN:
            return toMembershipMutationDescriptor(enqueue);
        case AppInboxType.GROUP_MEMBER_ROLE_SET:
        case AppInboxType.GROUP_OWNERSHIP_TRANSFER:
        case AppInboxType.GROUP_MEMBER_UPSERT:
            return toGovernanceMutationDescriptor(enqueue);
        case AppInboxType.GROUP_PRESENCE_CONNECT:
        case AppInboxType.GROUP_PRESENCE_HEARTBEAT:
        case AppInboxType.GROUP_PRESENCE_DISCONNECT:
            return toPresenceMutationDescriptor(enqueue);
        default: {
            const exhaustiveEnqueue: never = enqueue;
            void exhaustiveEnqueue;
            throw new GroupMutationAuthorizationError(
                'App inbox type is not an authenticated group mutation.'
            );
        }
    }
}

export interface GroupMutationDescriptorTargetIdentity {
    readonly targetPrincipalId: string | null;
    readonly sessionId: string | null;
}

export function toGroupMutationDescriptorTargetIdentity(
    command: GroupMutationCommand
): GroupMutationDescriptorTargetIdentity {
    switch (command.operation) {
        case 'connectPresence':
        case 'heartbeatPresence':
        case 'disconnectPresence':
            return {
                targetPrincipalId: command.input.principalId ?? null,
                sessionId: command.sessionId
            };
        case 'createGroupInvite':
        case 'revokeGroupInvite':
        case 'removeGroupMember':
        case 'banGroupMember':
        case 'unbanGroupMember':
        case 'grantGroupAdmission':
        case 'declineGroupAdmission':
        case 'setGroupMemberRole':
        case 'transferGroupOwnership':
        case 'upsertMember':
            return {
                targetPrincipalId: command.targetPrincipalId,
                sessionId: null
            };
        case 'createGroup':
        case 'updateGroup':
        case 'appointDirector':
        case 'startGroupEstablishment':
        case 'reopenGroupEstablishment':
        case 'activateGroup':
        case 'failGroupFormation':
        case 'joinGroup':
        case 'acceptGroupInvite':
        case 'rotateGroupJoinCode':
            return { targetPrincipalId: null, sessionId: null };
        default: {
            const exhaustiveCommand: never = command;
            void exhaustiveCommand;
            throw new TypeError('Unsupported group mutation command');
        }
    }
}

function toAggregateMutationDescriptor(
    enqueue: Extract<
        AuthenticatedGroupMutationEnqueue,
        | { readonly type: typeof AppInboxType.GROUP_CREATE; }
        | { readonly type: typeof AppInboxType.GROUP_UPDATE; }
        | { readonly type: typeof AppInboxType.GROUP_DIRECTOR_APPOINT; }
        | { readonly type: typeof AppInboxType.GROUP_ESTABLISHMENT_START; }
        | { readonly type: typeof AppInboxType.GROUP_ACTIVATE; }
        | { readonly type: typeof AppInboxType.GROUP_ESTABLISHMENT_REOPEN; }
        | { readonly type: typeof AppInboxType.GROUP_JOIN_CODE_ROTATE; }
    >
): GroupMutationDescriptor {
    const enqueueType = enqueue.type;
    switch (enqueue.type) {
        case AppInboxType.GROUP_CREATE: {
            return mutationDescriptor(
                'createGroup',
                enqueue.data.scope,
                enqueue.data.request.groupId,
                enqueue.data.request
            );
        }
        case AppInboxType.GROUP_UPDATE: {
            return mutationDescriptor(
                'updateGroup',
                enqueue.data.scope,
                enqueue.data.groupId,
                enqueue.data.request
            );
        }
        case AppInboxType.GROUP_DIRECTOR_APPOINT: {
            return mutationDescriptor(
                'appointDirector',
                enqueue.data.scope,
                enqueue.data.groupId,
                enqueue.data.request
            );
        }
        case AppInboxType.GROUP_ESTABLISHMENT_START: {
            return mutationDescriptor(
                'startGroupEstablishment',
                enqueue.data.scope,
                enqueue.data.groupId,
                enqueue.data.request
            );
        }
        case AppInboxType.GROUP_ACTIVATE: {
            return mutationDescriptor(
                'activateGroup',
                enqueue.data.scope,
                enqueue.data.groupId,
                enqueue.data.request
            );
        }
        case AppInboxType.GROUP_ESTABLISHMENT_REOPEN: {
            return mutationDescriptor(
                'reopenGroupEstablishment',
                enqueue.data.scope,
                enqueue.data.groupId,
                enqueue.data.request
            );
        }
        case AppInboxType.GROUP_JOIN_CODE_ROTATE: {
            return mutationDescriptor(
                'rotateGroupJoinCode',
                enqueue.data.scope,
                enqueue.data.groupId,
                enqueue.data.request
            );
        }
        default: {
            const exhaustiveEnqueue: never = enqueue;
            void exhaustiveEnqueue;
            throw new TypeError(`Unsupported aggregate AppInbox type: ${enqueueType}`);
        }
    }
}

function toAdmissionMutationDescriptor(
    enqueue: Extract<
        AuthenticatedGroupMutationEnqueue,
        | { readonly type: typeof AppInboxType.GROUP_JOIN; }
        | { readonly type: typeof AppInboxType.GROUP_INVITE_CREATE; }
        | { readonly type: typeof AppInboxType.GROUP_INVITE_REVOKE; }
        | { readonly type: typeof AppInboxType.GROUP_INVITE_ACCEPT; }
        | { readonly type: typeof AppInboxType.GROUP_ADMISSION_GRANT; }
        | { readonly type: typeof AppInboxType.GROUP_ADMISSION_DECLINE; }
    >
): GroupMutationDescriptor {
    const enqueueType = enqueue.type;
    switch (enqueue.type) {
        case AppInboxType.GROUP_JOIN: {
            return mutationDescriptor(
                'joinGroup',
                enqueue.data.scope,
                enqueue.data.groupId,
                enqueue.data.request
            );
        }
        case AppInboxType.GROUP_INVITE_CREATE: {
            return mutationDescriptor(
                'createGroupInvite',
                enqueue.data.scope,
                enqueue.data.groupId,
                enqueue.data.request,
                enqueue.data.principalId
            );
        }
        case AppInboxType.GROUP_INVITE_REVOKE: {
            return mutationDescriptor(
                'revokeGroupInvite',
                enqueue.data.scope,
                enqueue.data.groupId,
                enqueue.data.request,
                enqueue.data.principalId
            );
        }
        case AppInboxType.GROUP_INVITE_ACCEPT: {
            return mutationDescriptor(
                'acceptGroupInvite',
                enqueue.data.scope,
                enqueue.data.groupId,
                enqueue.data.request
            );
        }
        case AppInboxType.GROUP_ADMISSION_GRANT: {
            return mutationDescriptor(
                'grantGroupAdmission',
                enqueue.data.scope,
                enqueue.data.groupId,
                enqueue.data.request,
                enqueue.data.principalId
            );
        }
        case AppInboxType.GROUP_ADMISSION_DECLINE: {
            return mutationDescriptor(
                'declineGroupAdmission',
                enqueue.data.scope,
                enqueue.data.groupId,
                enqueue.data.request,
                enqueue.data.principalId
            );
        }
        default: {
            const exhaustiveEnqueue: never = enqueue;
            void exhaustiveEnqueue;
            throw new TypeError(`Unsupported admission AppInbox type: ${enqueueType}`);
        }
    }
}

function toMembershipMutationDescriptor(
    enqueue: Extract<
        AuthenticatedGroupMutationEnqueue,
        | { readonly type: typeof AppInboxType.GROUP_MEMBER_REMOVE; }
        | { readonly type: typeof AppInboxType.GROUP_MEMBER_BAN; }
        | { readonly type: typeof AppInboxType.GROUP_MEMBER_UNBAN; }
    >
): GroupMutationDescriptor {
    const enqueueType = enqueue.type;
    switch (enqueue.type) {
        case AppInboxType.GROUP_MEMBER_REMOVE: {
            return mutationDescriptor(
                'removeGroupMember',
                enqueue.data.scope,
                enqueue.data.groupId,
                enqueue.data.request,
                enqueue.data.principalId
            );
        }
        case AppInboxType.GROUP_MEMBER_BAN: {
            return mutationDescriptor(
                'banGroupMember',
                enqueue.data.scope,
                enqueue.data.groupId,
                enqueue.data.request,
                enqueue.data.principalId
            );
        }
        case AppInboxType.GROUP_MEMBER_UNBAN: {
            return mutationDescriptor(
                'unbanGroupMember',
                enqueue.data.scope,
                enqueue.data.groupId,
                enqueue.data.request,
                enqueue.data.principalId
            );
        }
        default: {
            const exhaustiveEnqueue: never = enqueue;
            void exhaustiveEnqueue;
            throw new TypeError(`Unsupported membership AppInbox type: ${enqueueType}`);
        }
    }
}

function toGovernanceMutationDescriptor(
    enqueue: Extract<
        AuthenticatedGroupMutationEnqueue,
        | { readonly type: typeof AppInboxType.GROUP_MEMBER_ROLE_SET; }
        | { readonly type: typeof AppInboxType.GROUP_OWNERSHIP_TRANSFER; }
        | { readonly type: typeof AppInboxType.GROUP_MEMBER_UPSERT; }
    >
): GroupMutationDescriptor {
    const enqueueType = enqueue.type;
    switch (enqueue.type) {
        case AppInboxType.GROUP_MEMBER_ROLE_SET: {
            return mutationDescriptor(
                'setGroupMemberRole',
                enqueue.data.scope,
                enqueue.data.groupId,
                enqueue.data.request,
                enqueue.data.principalId
            );
        }
        case AppInboxType.GROUP_OWNERSHIP_TRANSFER: {
            return mutationDescriptor(
                'transferGroupOwnership',
                enqueue.data.scope,
                enqueue.data.groupId,
                enqueue.data.request,
                enqueue.data.request.newOwnerPrincipalId
            );
        }
        case AppInboxType.GROUP_MEMBER_UPSERT: {
            return mutationDescriptor(
                'upsertMember',
                enqueue.data.scope,
                enqueue.data.groupId,
                enqueue.data.request,
                enqueue.data.principalId
            );
        }
        default: {
            const exhaustiveEnqueue: never = enqueue;
            void exhaustiveEnqueue;
            throw new TypeError(`Unsupported governance AppInbox type: ${enqueueType}`);
        }
    }
}

function toPresenceMutationDescriptor(
    enqueue: Extract<
        AuthenticatedGroupMutationEnqueue,
        | { readonly type: typeof AppInboxType.GROUP_PRESENCE_CONNECT; }
        | { readonly type: typeof AppInboxType.GROUP_PRESENCE_HEARTBEAT; }
        | { readonly type: typeof AppInboxType.GROUP_PRESENCE_DISCONNECT; }
    >
): GroupMutationDescriptor {
    const enqueueType = enqueue.type;
    switch (enqueue.type) {
        case AppInboxType.GROUP_PRESENCE_CONNECT: {
            return mutationDescriptor(
                'connectPresence',
                enqueue.data.scope,
                enqueue.data.groupId,
                enqueue.data.request,
                enqueue.data.request.principalId,
                enqueue.data.sessionId
            );
        }
        case AppInboxType.GROUP_PRESENCE_HEARTBEAT: {
            return mutationDescriptor(
                'heartbeatPresence',
                enqueue.data.scope,
                enqueue.data.groupId,
                enqueue.data.request,
                enqueue.data.request.principalId ?? null,
                enqueue.data.sessionId
            );
        }
        case AppInboxType.GROUP_PRESENCE_DISCONNECT: {
            return mutationDescriptor(
                'disconnectPresence',
                enqueue.data.scope,
                enqueue.data.groupId,
                enqueue.data.request,
                enqueue.data.request.principalId ?? null,
                enqueue.data.sessionId
            );
        }
        default: {
            const exhaustiveEnqueue: never = enqueue;
            void exhaustiveEnqueue;
            throw new TypeError(`Unsupported presence AppInbox type: ${enqueueType}`);
        }
    }
}
