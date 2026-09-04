import { AppInboxType } from '../../app-inbox/app-inbox-contracts.ts';
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
        case AppInboxType.GROUP_PLAN:
        case AppInboxType.GROUP_CONNECT:
        case AppInboxType.GROUP_FORMATION_START:
        case AppInboxType.GROUP_FORMATION_RESET:
        case AppInboxType.GROUP_ACTIVATE:
        case AppInboxType.GROUP_RECONFIGURE:
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
        case AppInboxType.GROUP_TRANSPORT_PAUSE:
        case AppInboxType.GROUP_TRANSPORT_RESUME:
            return toTransportMutationDescriptor(enqueue);
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
        case 'planGroupLayout':
        case 'connectGroup':
        case 'startGroupFormation':
        case 'resetGroupFormation':
        case 'activateGroup':
        case 'reconfigureGroup':
        case 'failGroupFormation':
        case 'applyPlannedLayout':
        case 'updateGroupActivationStatus':
        case 'pauseGroupTransport':
        case 'resumeGroupTransport':
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
        | { readonly type: typeof AppInboxType.GROUP_PLAN; }
        | { readonly type: typeof AppInboxType.GROUP_CONNECT; }
        | { readonly type: typeof AppInboxType.GROUP_FORMATION_START; }
        | { readonly type: typeof AppInboxType.GROUP_FORMATION_RESET; }
        | { readonly type: typeof AppInboxType.GROUP_ACTIVATE; }
        | { readonly type: typeof AppInboxType.GROUP_RECONFIGURE; }
        | { readonly type: typeof AppInboxType.GROUP_JOIN_CODE_ROTATE; }
    >
): GroupMutationDescriptor {
    const enqueueType = enqueue.type;
    if (enqueue.type === AppInboxType.GROUP_CREATE) {
        return mutationDescriptor({
            operation: 'createGroup',
            scope: enqueue.data.scope,
            groupId: enqueue.data.request.groupId,
            request: enqueue.data.request
        });
    }
    const common = { scope: enqueue.data.scope, groupId: enqueue.data.groupId, request: enqueue.data.request };
    switch (enqueue.type) {
        case AppInboxType.GROUP_UPDATE:
            return mutationDescriptor({ ...common, operation: 'updateGroup' });
        case AppInboxType.GROUP_DIRECTOR_APPOINT:
            return mutationDescriptor({ ...common, operation: 'appointDirector' });
        case AppInboxType.GROUP_PLAN:
            return mutationDescriptor({ ...common, operation: 'planGroupLayout' });
        case AppInboxType.GROUP_CONNECT:
            return mutationDescriptor({ ...common, operation: 'connectGroup' });
        case AppInboxType.GROUP_FORMATION_START:
            return mutationDescriptor({ ...common, operation: 'startGroupFormation' });
        case AppInboxType.GROUP_FORMATION_RESET:
            return mutationDescriptor({ ...common, operation: 'resetGroupFormation' });
        case AppInboxType.GROUP_ACTIVATE:
            return mutationDescriptor({ ...common, operation: 'activateGroup' });
        case AppInboxType.GROUP_RECONFIGURE:
            return mutationDescriptor({ ...common, operation: 'reconfigureGroup' });
        case AppInboxType.GROUP_JOIN_CODE_ROTATE:
            return mutationDescriptor({ ...common, operation: 'rotateGroupJoinCode' });
        default:
            throw new TypeError(`Unsupported aggregate AppInbox type: ${enqueueType}`);
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
    const common = { scope: enqueue.data.scope, groupId: enqueue.data.groupId, request: enqueue.data.request };
    switch (enqueue.type) {
        case AppInboxType.GROUP_JOIN: {
            return mutationDescriptor({ operation: 'joinGroup', ...common });
        }
        case AppInboxType.GROUP_INVITE_CREATE: {
            return mutationDescriptor({
                operation: 'createGroupInvite',
                ...common,
                targetPrincipalId: enqueue.data.principalId
            });
        }
        case AppInboxType.GROUP_INVITE_REVOKE: {
            return mutationDescriptor({
                operation: 'revokeGroupInvite',
                ...common,
                targetPrincipalId: enqueue.data.principalId
            });
        }
        case AppInboxType.GROUP_INVITE_ACCEPT: {
            return mutationDescriptor({
                operation: 'acceptGroupInvite',
                ...common
            });
        }
        case AppInboxType.GROUP_ADMISSION_GRANT: {
            return mutationDescriptor({
                operation: 'grantGroupAdmission',
                ...common,
                targetPrincipalId: enqueue.data.principalId
            });
        }
        case AppInboxType.GROUP_ADMISSION_DECLINE: {
            return mutationDescriptor({
                operation: 'declineGroupAdmission',
                ...common,
                targetPrincipalId: enqueue.data.principalId
            });
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
            return mutationDescriptor({
                operation: 'removeGroupMember',
                scope: enqueue.data.scope,
                groupId: enqueue.data.groupId,
                request: enqueue.data.request,
                targetPrincipalId: enqueue.data.principalId
            });
        }
        case AppInboxType.GROUP_MEMBER_BAN: {
            return mutationDescriptor({
                operation: 'banGroupMember',
                scope: enqueue.data.scope,
                groupId: enqueue.data.groupId,
                request: enqueue.data.request,
                targetPrincipalId: enqueue.data.principalId
            });
        }
        case AppInboxType.GROUP_MEMBER_UNBAN: {
            return mutationDescriptor({
                operation: 'unbanGroupMember',
                scope: enqueue.data.scope,
                groupId: enqueue.data.groupId,
                request: enqueue.data.request,
                targetPrincipalId: enqueue.data.principalId
            });
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
            return mutationDescriptor({
                operation: 'setGroupMemberRole',
                scope: enqueue.data.scope,
                groupId: enqueue.data.groupId,
                request: enqueue.data.request,
                targetPrincipalId: enqueue.data.principalId
            });
        }
        case AppInboxType.GROUP_OWNERSHIP_TRANSFER: {
            return mutationDescriptor({
                operation: 'transferGroupOwnership',
                scope: enqueue.data.scope,
                groupId: enqueue.data.groupId,
                request: enqueue.data.request,
                targetPrincipalId: enqueue.data.request.newOwnerPrincipalId
            });
        }
        case AppInboxType.GROUP_MEMBER_UPSERT: {
            return mutationDescriptor({
                operation: 'upsertMember',
                scope: enqueue.data.scope,
                groupId: enqueue.data.groupId,
                request: enqueue.data.request,
                targetPrincipalId: enqueue.data.principalId
            });
        }
        default: {
            const exhaustiveEnqueue: never = enqueue;
            void exhaustiveEnqueue;
            throw new TypeError(`Unsupported governance AppInbox type: ${enqueueType}`);
        }
    }
}

function toTransportMutationDescriptor(
    enqueue: Extract<
        AuthenticatedGroupMutationEnqueue,
        | { readonly type: typeof AppInboxType.GROUP_TRANSPORT_PAUSE; }
        | { readonly type: typeof AppInboxType.GROUP_TRANSPORT_RESUME; }
    >
): GroupMutationDescriptor {
    const enqueueType = enqueue.type;
    switch (enqueue.type) {
        case AppInboxType.GROUP_TRANSPORT_PAUSE: {
            return mutationDescriptor({
                operation: 'pauseGroupTransport',
                scope: enqueue.data.scope,
                groupId: enqueue.data.groupId,
                request: enqueue.data.request
            });
        }
        case AppInboxType.GROUP_TRANSPORT_RESUME: {
            return mutationDescriptor({
                operation: 'resumeGroupTransport',
                scope: enqueue.data.scope,
                groupId: enqueue.data.groupId,
                request: enqueue.data.request
            });
        }
        default: {
            const exhaustiveEnqueue: never = enqueue;
            void exhaustiveEnqueue;
            throw new TypeError(`Unsupported transport AppInbox type: ${enqueueType}`);
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
            return mutationDescriptor({
                operation: 'connectPresence',
                scope: enqueue.data.scope,
                groupId: enqueue.data.groupId,
                request: enqueue.data.request,
                targetPrincipalId: enqueue.data.request.principalId,
                sessionId: enqueue.data.sessionId
            });
        }
        case AppInboxType.GROUP_PRESENCE_HEARTBEAT: {
            return mutationDescriptor({
                operation: 'heartbeatPresence',
                scope: enqueue.data.scope,
                groupId: enqueue.data.groupId,
                request: enqueue.data.request,
                targetPrincipalId: enqueue.data.request.principalId ?? null,
                sessionId: enqueue.data.sessionId
            });
        }
        case AppInboxType.GROUP_PRESENCE_DISCONNECT: {
            return mutationDescriptor({
                operation: 'disconnectPresence',
                scope: enqueue.data.scope,
                groupId: enqueue.data.groupId,
                request: enqueue.data.request,
                targetPrincipalId: enqueue.data.request.principalId ?? null,
                sessionId: enqueue.data.sessionId
            });
        }
        default: {
            const exhaustiveEnqueue: never = enqueue;
            void exhaustiveEnqueue;
            throw new TypeError(`Unsupported presence AppInbox type: ${enqueueType}`);
        }
    }
}
