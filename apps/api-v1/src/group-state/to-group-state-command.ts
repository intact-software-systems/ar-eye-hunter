import type {
    AuthenticatedGroupMutationEnqueue
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import { AppInboxType } from '@shared-server/rallar-system/services/AppInboxService.ts';
import {
    validateGroupMutationRequest,
    validateGroupPresenceMutationRequest
} from '@shared-server/rallar-system/services/group-state-mutations.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import type { GroupStateRouteCommandInput } from './group-state-route-contracts.ts';

type GroupStateCommand<TType extends AuthenticatedGroupMutationEnqueue['type']> = Extract<
    AuthenticatedGroupMutationEnqueue,
    { type: TType; }
>;

export function toGroupStateCommand(
    input: GroupStateRouteCommandInput
): AuthenticatedGroupMutationEnqueue {
    switch (input.operation) {
        case 'create-group':
            return toCreateGroupCommand(input);
        case 'update-group':
            return toUpdateGroupCommand(input);
        case 'appoint-group-director':
            return toAppointGroupDirectorCommand(input);
        case 'start-group-establishment':
            return toStartGroupEstablishmentCommand(input);
        case 'activate-group':
            return toActivateGroupCommand(input);
        case 'reopen-group-establishment':
            return toReopenGroupEstablishmentCommand(input);
        case 'join-group':
            return toJoinGroupCommand(input);
        case 'accept-group-invite':
            return toAcceptGroupInviteCommand(input);
        case 'rotate-group-join-code':
            return toRotateGroupJoinCodeCommand(input);
        case 'create-group-invite':
            return toCreateGroupInviteCommand(input);
        case 'revoke-group-invite':
            return toRevokeGroupInviteCommand(input);
        case 'grant-group-admission':
            return toGrantGroupAdmissionCommand(input);
        case 'decline-group-admission':
            return toDeclineGroupAdmissionCommand(input);
        case 'remove-group-member':
            return toRemoveGroupMemberCommand(input);
        case 'ban-group-member':
            return toBanGroupMemberCommand(input);
        case 'unban-group-member':
            return toUnbanGroupMemberCommand(input);
        case 'set-group-member-role':
            return toSetGroupMemberRoleCommand(input);
        case 'transfer-group-ownership':
            return toTransferGroupOwnershipCommand(input);
        case 'upsert-group-member':
            return toUpsertGroupMemberCommand(input);
        case 'connect-group-presence':
            return toConnectGroupPresenceCommand(input);
        case 'heartbeat-group-presence':
            return toHeartbeatGroupPresenceCommand(input);
        case 'disconnect-group-presence':
            return toDisconnectGroupPresenceCommand(input);
    }
}

function toCreateGroupCommand(
    input: Extract<GroupStateRouteCommandInput, { operation: 'create-group'; }>
): GroupStateCommand<typeof AppInboxType.GROUP_CREATE> {
    const request = {
        ...input.request,
        createdByPrincipalId: input.authSession.clientId,
        actorPrincipalId: input.authSession.clientId,
        actorSessionId: input.authSession.sessionId
    };
    validateGroupMutationRequest('createGroup', request);

    return {
        type: AppInboxType.GROUP_CREATE,
        topicId: AppInboxType.GROUP_CREATE,
        resourceId: request.requestId,
        contextId: toGroupAppInboxContextId(input.scope, request.groupId, input.authSession),
        senderId: input.authSession.clientId,
        data: {
            scope: input.scope,
            request
        }
    };
}

function toUpdateGroupCommand(
    input: Extract<GroupStateRouteCommandInput, { operation: 'update-group'; }>
): GroupStateCommand<typeof AppInboxType.GROUP_UPDATE> {
    const request = withActor(input);
    validateGroupMutationRequest('updateGroup', request);

    return {
        type: AppInboxType.GROUP_UPDATE,
        topicId: AppInboxType.GROUP_UPDATE,
        resourceId: request.requestId,
        contextId: toGroupAppInboxContextId(input.scope, input.groupId, input.authSession),
        senderId: input.authSession.clientId,
        data: {
            scope: input.scope,
            groupId: input.groupId,
            request
        }
    };
}

function toAppointGroupDirectorCommand(
    input: Extract<GroupStateRouteCommandInput, { operation: 'appoint-group-director'; }>
): GroupStateCommand<typeof AppInboxType.GROUP_DIRECTOR_APPOINT> {
    const request = withActor(input);
    validateGroupMutationRequest('appointDirector', request);

    return {
        type: AppInboxType.GROUP_DIRECTOR_APPOINT,
        topicId: AppInboxType.GROUP_DIRECTOR_APPOINT,
        resourceId: request.requestId,
        contextId: toGroupAppInboxContextId(input.scope, input.groupId, input.authSession),
        senderId: input.authSession.clientId,
        data: {
            scope: input.scope,
            groupId: input.groupId,
            request
        }
    };
}

function toStartGroupEstablishmentCommand(
    input: Extract<GroupStateRouteCommandInput, { operation: 'start-group-establishment'; }>
): GroupStateCommand<typeof AppInboxType.GROUP_ESTABLISHMENT_START> {
    const request = withActor(input);
    validateGroupMutationRequest('startGroupEstablishment', request);

    return {
        type: AppInboxType.GROUP_ESTABLISHMENT_START,
        topicId: AppInboxType.GROUP_ESTABLISHMENT_START,
        resourceId: request.requestId,
        contextId: toGroupAppInboxContextId(input.scope, input.groupId, input.authSession),
        senderId: input.authSession.clientId,
        data: {
            scope: input.scope,
            groupId: input.groupId,
            request
        }
    };
}

function toActivateGroupCommand(
    input: Extract<GroupStateRouteCommandInput, { operation: 'activate-group'; }>
): GroupStateCommand<typeof AppInboxType.GROUP_ACTIVATE> {
    const request = withActor(input);
    validateGroupMutationRequest('activateGroup', request);

    return {
        type: AppInboxType.GROUP_ACTIVATE,
        topicId: AppInboxType.GROUP_ACTIVATE,
        resourceId: request.requestId,
        contextId: toGroupAppInboxContextId(input.scope, input.groupId, input.authSession),
        senderId: input.authSession.clientId,
        data: {
            scope: input.scope,
            groupId: input.groupId,
            request
        }
    };
}

function toReopenGroupEstablishmentCommand(
    input: Extract<GroupStateRouteCommandInput, { operation: 'reopen-group-establishment'; }>
): GroupStateCommand<typeof AppInboxType.GROUP_ESTABLISHMENT_REOPEN> {
    const request = withActor(input);
    validateGroupMutationRequest('reopenGroupEstablishment', request);

    return {
        type: AppInboxType.GROUP_ESTABLISHMENT_REOPEN,
        topicId: AppInboxType.GROUP_ESTABLISHMENT_REOPEN,
        resourceId: request.requestId,
        contextId: toGroupAppInboxContextId(input.scope, input.groupId, input.authSession),
        senderId: input.authSession.clientId,
        data: {
            scope: input.scope,
            groupId: input.groupId,
            request
        }
    };
}

function toJoinGroupCommand(
    input: Extract<GroupStateRouteCommandInput, { operation: 'join-group'; }>
): GroupStateCommand<typeof AppInboxType.GROUP_JOIN> {
    const request = withActor(input);
    validateGroupMutationRequest('joinGroup', request);

    return {
        type: AppInboxType.GROUP_JOIN,
        topicId: AppInboxType.GROUP_JOIN,
        resourceId: request.requestId,
        contextId: toGroupAppInboxContextId(input.scope, input.groupId, input.authSession),
        senderId: input.authSession.clientId,
        data: { scope: input.scope, groupId: input.groupId, request }
    };
}

function toAcceptGroupInviteCommand(
    input: Extract<GroupStateRouteCommandInput, { operation: 'accept-group-invite'; }>
): GroupStateCommand<typeof AppInboxType.GROUP_INVITE_ACCEPT> {
    const request = withActor(input);
    validateGroupMutationRequest('acceptGroupInvite', request);

    return {
        type: AppInboxType.GROUP_INVITE_ACCEPT,
        topicId: AppInboxType.GROUP_INVITE_ACCEPT,
        resourceId: request.requestId,
        contextId: toGroupAppInboxContextId(input.scope, input.groupId, input.authSession),
        senderId: input.authSession.clientId,
        data: { scope: input.scope, groupId: input.groupId, request }
    };
}

function toRotateGroupJoinCodeCommand(
    input: Extract<GroupStateRouteCommandInput, { operation: 'rotate-group-join-code'; }>
): GroupStateCommand<typeof AppInboxType.GROUP_JOIN_CODE_ROTATE> {
    const request = withActor(input);
    validateGroupMutationRequest('rotateGroupJoinCode', request);

    return {
        type: AppInboxType.GROUP_JOIN_CODE_ROTATE,
        topicId: AppInboxType.GROUP_JOIN_CODE_ROTATE,
        resourceId: request.requestId,
        contextId: toGroupAppInboxContextId(input.scope, input.groupId, input.authSession),
        senderId: input.authSession.clientId,
        data: { scope: input.scope, groupId: input.groupId, request }
    };
}

function toCreateGroupInviteCommand(
    input: Extract<GroupStateRouteCommandInput, { operation: 'create-group-invite'; }>
): GroupStateCommand<typeof AppInboxType.GROUP_INVITE_CREATE> {
    const request = withActor(input);
    validateGroupMutationRequest('createGroupInvite', request);

    return {
        type: AppInboxType.GROUP_INVITE_CREATE,
        topicId: AppInboxType.GROUP_INVITE_CREATE,
        resourceId: request.requestId,
        contextId: toGroupAppInboxContextId(input.scope, input.groupId, input.authSession),
        senderId: input.authSession.clientId,
        data: {
            scope: input.scope,
            groupId: input.groupId,
            principalId: input.principalId,
            request
        }
    };
}

function toRevokeGroupInviteCommand(
    input: Extract<GroupStateRouteCommandInput, { operation: 'revoke-group-invite'; }>
): GroupStateCommand<typeof AppInboxType.GROUP_INVITE_REVOKE> {
    const request = withActor(input);
    validateGroupMutationRequest('revokeGroupInvite', request);

    return {
        type: AppInboxType.GROUP_INVITE_REVOKE,
        topicId: AppInboxType.GROUP_INVITE_REVOKE,
        resourceId: request.requestId,
        contextId: toGroupAppInboxContextId(input.scope, input.groupId, input.authSession),
        senderId: input.authSession.clientId,
        data: {
            scope: input.scope,
            groupId: input.groupId,
            principalId: input.principalId,
            request
        }
    };
}

function toGrantGroupAdmissionCommand(
    input: Extract<GroupStateRouteCommandInput, { operation: 'grant-group-admission'; }>
): GroupStateCommand<typeof AppInboxType.GROUP_ADMISSION_GRANT> {
    const request = withActor(input);
    validateGroupMutationRequest('grantGroupAdmission', request);

    return {
        type: AppInboxType.GROUP_ADMISSION_GRANT,
        topicId: AppInboxType.GROUP_ADMISSION_GRANT,
        resourceId: request.requestId,
        contextId: toGroupAppInboxContextId(input.scope, input.groupId, input.authSession),
        senderId: input.authSession.clientId,
        data: {
            scope: input.scope,
            groupId: input.groupId,
            principalId: input.principalId,
            request
        }
    };
}

function toDeclineGroupAdmissionCommand(
    input: Extract<GroupStateRouteCommandInput, { operation: 'decline-group-admission'; }>
): GroupStateCommand<typeof AppInboxType.GROUP_ADMISSION_DECLINE> {
    const request = withActor(input);
    validateGroupMutationRequest('declineGroupAdmission', request);

    return {
        type: AppInboxType.GROUP_ADMISSION_DECLINE,
        topicId: AppInboxType.GROUP_ADMISSION_DECLINE,
        resourceId: request.requestId,
        contextId: toGroupAppInboxContextId(input.scope, input.groupId, input.authSession),
        senderId: input.authSession.clientId,
        data: {
            scope: input.scope,
            groupId: input.groupId,
            principalId: input.principalId,
            request
        }
    };
}

function toRemoveGroupMemberCommand(
    input: Extract<GroupStateRouteCommandInput, { operation: 'remove-group-member'; }>
): GroupStateCommand<typeof AppInboxType.GROUP_MEMBER_REMOVE> {
    const request = withActor(input);
    validateGroupMutationRequest('removeGroupMember', request);

    return {
        type: AppInboxType.GROUP_MEMBER_REMOVE,
        topicId: AppInboxType.GROUP_MEMBER_REMOVE,
        resourceId: request.requestId,
        contextId: toGroupAppInboxContextId(input.scope, input.groupId, input.authSession),
        senderId: input.authSession.clientId,
        data: { scope: input.scope, groupId: input.groupId, principalId: input.principalId, request }
    };
}

function toBanGroupMemberCommand(
    input: Extract<GroupStateRouteCommandInput, { operation: 'ban-group-member'; }>
): GroupStateCommand<typeof AppInboxType.GROUP_MEMBER_BAN> {
    const request = withActor(input);
    validateGroupMutationRequest('banGroupMember', request);

    return {
        type: AppInboxType.GROUP_MEMBER_BAN,
        topicId: AppInboxType.GROUP_MEMBER_BAN,
        resourceId: request.requestId,
        contextId: toGroupAppInboxContextId(input.scope, input.groupId, input.authSession),
        senderId: input.authSession.clientId,
        data: { scope: input.scope, groupId: input.groupId, principalId: input.principalId, request }
    };
}

function toUnbanGroupMemberCommand(
    input: Extract<GroupStateRouteCommandInput, { operation: 'unban-group-member'; }>
): GroupStateCommand<typeof AppInboxType.GROUP_MEMBER_UNBAN> {
    const request = withActor(input);
    validateGroupMutationRequest('unbanGroupMember', request);

    return {
        type: AppInboxType.GROUP_MEMBER_UNBAN,
        topicId: AppInboxType.GROUP_MEMBER_UNBAN,
        resourceId: request.requestId,
        contextId: toGroupAppInboxContextId(input.scope, input.groupId, input.authSession),
        senderId: input.authSession.clientId,
        data: { scope: input.scope, groupId: input.groupId, principalId: input.principalId, request }
    };
}

function toSetGroupMemberRoleCommand(
    input: Extract<GroupStateRouteCommandInput, { operation: 'set-group-member-role'; }>
): GroupStateCommand<typeof AppInboxType.GROUP_MEMBER_ROLE_SET> {
    const request = withActor(input);
    validateGroupMutationRequest('setGroupMemberRole', request);

    return {
        type: AppInboxType.GROUP_MEMBER_ROLE_SET,
        topicId: AppInboxType.GROUP_MEMBER_ROLE_SET,
        resourceId: request.requestId,
        contextId: toGroupAppInboxContextId(input.scope, input.groupId, input.authSession),
        senderId: input.authSession.clientId,
        data: { scope: input.scope, groupId: input.groupId, principalId: input.principalId, request }
    };
}

function toTransferGroupOwnershipCommand(
    input: Extract<GroupStateRouteCommandInput, { operation: 'transfer-group-ownership'; }>
): GroupStateCommand<typeof AppInboxType.GROUP_OWNERSHIP_TRANSFER> {
    const request = withActor(input);
    validateGroupMutationRequest('transferGroupOwnership', request);

    return {
        type: AppInboxType.GROUP_OWNERSHIP_TRANSFER,
        topicId: AppInboxType.GROUP_OWNERSHIP_TRANSFER,
        resourceId: request.requestId,
        contextId: toGroupAppInboxContextId(input.scope, input.groupId, input.authSession),
        senderId: input.authSession.clientId,
        data: { scope: input.scope, groupId: input.groupId, request }
    };
}

function toUpsertGroupMemberCommand(
    input: Extract<GroupStateRouteCommandInput, { operation: 'upsert-group-member'; }>
): GroupStateCommand<typeof AppInboxType.GROUP_MEMBER_UPSERT> {
    const requestWithActor = withActor(input);
    validateGroupMutationRequest('upsertMember', requestWithActor);
    const { role: _ignoredRole, ...request } = requestWithActor;

    return {
        type: AppInboxType.GROUP_MEMBER_UPSERT,
        topicId: AppInboxType.GROUP_MEMBER_UPSERT,
        resourceId: request.requestId,
        contextId: toGroupAppInboxContextId(input.scope, input.groupId, input.authSession),
        senderId: input.authSession.clientId,
        data: { scope: input.scope, groupId: input.groupId, principalId: input.principalId, request }
    };
}

function toConnectGroupPresenceCommand(
    input: Extract<GroupStateRouteCommandInput, { operation: 'connect-group-presence'; }>
): GroupStateCommand<typeof AppInboxType.GROUP_PRESENCE_CONNECT> {
    validateGroupPresenceMutationRequest('connectPresence', input.request);
    const request = withPresenceActor(input);

    return {
        type: AppInboxType.GROUP_PRESENCE_CONNECT,
        topicId: AppInboxType.GROUP_PRESENCE_CONNECT,
        resourceId: request.requestId,
        contextId: toGroupAppInboxContextId(input.scope, input.groupId, input.authSession),
        senderId: input.authSession.clientId,
        data: { scope: input.scope, groupId: input.groupId, sessionId: input.sessionId, request }
    };
}

function toHeartbeatGroupPresenceCommand(
    input: Extract<GroupStateRouteCommandInput, { operation: 'heartbeat-group-presence'; }>
): GroupStateCommand<typeof AppInboxType.GROUP_PRESENCE_HEARTBEAT> {
    validateGroupPresenceMutationRequest('heartbeatPresence', input.request);
    const request = withPresenceActor(input);

    return {
        type: AppInboxType.GROUP_PRESENCE_HEARTBEAT,
        topicId: AppInboxType.GROUP_PRESENCE_HEARTBEAT,
        resourceId: request.requestId,
        contextId: toGroupAppInboxContextId(input.scope, input.groupId, input.authSession),
        senderId: input.authSession.clientId,
        data: { scope: input.scope, groupId: input.groupId, sessionId: input.sessionId, request }
    };
}

function toDisconnectGroupPresenceCommand(
    input: Extract<GroupStateRouteCommandInput, { operation: 'disconnect-group-presence'; }>
): GroupStateCommand<typeof AppInboxType.GROUP_PRESENCE_DISCONNECT> {
    validateGroupPresenceMutationRequest('disconnectPresence', input.request);
    const request = withPresenceActor(input);

    return {
        type: AppInboxType.GROUP_PRESENCE_DISCONNECT,
        topicId: AppInboxType.GROUP_PRESENCE_DISCONNECT,
        resourceId: request.requestId,
        contextId: toGroupAppInboxContextId(input.scope, input.groupId, input.authSession),
        senderId: input.authSession.clientId,
        data: { scope: input.scope, groupId: input.groupId, sessionId: input.sessionId, request }
    };
}

function withActor<T extends { actorPrincipalId?: string; actorSessionId?: string; }>(
    input: Readonly<{
        request: T;
        authSession: Readonly<{ clientId: string; sessionId: string; }>;
    }>
): T {
    return {
        ...input.request,
        actorPrincipalId: input.authSession.clientId,
        actorSessionId: input.authSession.sessionId
    };
}

function withPresenceActor<T extends { actorPrincipalId?: string; actorSessionId?: string; principalId?: string; }>(
    input: Readonly<{
        request: T;
        authSession: Readonly<{ clientId: string; sessionId: string; }>;
    }>
): T {
    return {
        ...input.request,
        principalId: input.authSession.clientId,
        actorPrincipalId: input.authSession.clientId,
        actorSessionId: input.authSession.sessionId
    };
}

function toGroupAppInboxContextId(
    scope: StateScope,
    groupId: string,
    authSession: Readonly<{ clientId: string; }>
): string {
    return [
        ['application', scope.applicationId],
        ['workspace', scope.workspaceId],
        ['group', groupId],
        ['caller', authSession.clientId]
    ].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join(':');
}
