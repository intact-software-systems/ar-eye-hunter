import { AppInboxType } from '../../app-inbox/app-inbox-contracts.ts';
import { requireExactKeys, requireString } from '../../protocol/exact-object-decoding.ts';
import type { JsonWireObject, JsonWireValue } from '../../protocol/json-wire-identity.ts';
import { validateGroupMutationRequest } from '../mutation/command-validation/group-mutation-request-validation.ts';
import type { GroupMutationCommand } from '../mutation/group-mutation-contracts.ts';
import type { AuthenticatedGroupMutationInboxType } from './group-state-inbox-contracts.ts';

const TARGET_PRINCIPAL_TYPES = new Set<AuthenticatedGroupMutationInboxType>([
    AppInboxType.GROUP_INVITE_CREATE,
    AppInboxType.GROUP_INVITE_REVOKE,
    AppInboxType.GROUP_ADMISSION_GRANT,
    AppInboxType.GROUP_ADMISSION_DECLINE,
    AppInboxType.GROUP_MEMBER_REMOVE,
    AppInboxType.GROUP_MEMBER_BAN,
    AppInboxType.GROUP_MEMBER_UNBAN,
    AppInboxType.GROUP_MEMBER_ROLE_SET,
    AppInboxType.GROUP_MEMBER_UPSERT
]);

const PRESENCE_TYPES = new Set<AuthenticatedGroupMutationInboxType>([
    AppInboxType.GROUP_PRESENCE_CONNECT,
    AppInboxType.GROUP_PRESENCE_HEARTBEAT,
    AppInboxType.GROUP_PRESENCE_DISCONNECT
]);

export function decodeGroupStateAppInboxCommand(
    type: Exclude<AppInboxType, typeof AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP>,
    value: JsonWireValue
): JsonWireValue {
    if (
        type === AppInboxType.GROUP_PRESENCE_EXPIRE ||
        type === AppInboxType.GROUP_FORMATION_AUTOMATION ||
        type === AppInboxType.GROUP_FORMATION_CRITERION ||
        type === AppInboxType.GROUP_TOPOLOGY_PUBLICATION
    ) {
        return decodePreparedGroupMutationIdentity(value);
    }
    if (!isAuthenticatedGroupMutationType(type)) {
        throw new TypeError(`AppInbox type ${type} is not a group mutation command`);
    }
    const command = requireJsonWireObject(value, `Group ${type} AppInbox command`);
    const operation = toGroupMutationOperation(type);
    if (type === AppInboxType.GROUP_CREATE) {
        requireExactKeys(command, ['scope', 'request'], `Group ${type} AppInbox command`);
    }
    else if (TARGET_PRINCIPAL_TYPES.has(type)) {
        requireExactKeys(
            command,
            ['scope', 'groupId', 'principalId', 'request'],
            `Group ${type} AppInbox command`
        );
        requireString(command.principalId, `Group ${type} target principal id`);
    }
    else if (PRESENCE_TYPES.has(type)) {
        requireExactKeys(
            command,
            ['scope', 'groupId', 'sessionId', 'request'],
            `Group ${type} AppInbox command`
        );
        requireString(command.sessionId, `Group ${type} session id`);
    }
    else {
        requireExactKeys(
            command,
            ['scope', 'groupId', 'request'],
            `Group ${type} AppInbox command`
        );
    }
    decodeGroupScope(command.scope, type);
    if (type !== AppInboxType.GROUP_CREATE) {
        requireString(command.groupId, `Group ${type} group id`);
    }
    validatePersistedGroupMutationRequest(operation, command.request);
    return value;
}

function validatePersistedGroupMutationRequest(
    operation: GroupMutationCommand['operation'],
    value: JsonWireValue | undefined
): void {
    const request = requireJsonWireObject(value, `Group ${operation} request`);
    validateGroupMutationRequest(operation, {
        ...request,
        actorPrincipalId: request.actorPrincipalId === undefined
            ? 'app-inbox-authority-principal'
            : request.actorPrincipalId,
        actorSessionId: request.actorSessionId === undefined
            ? 'app-inbox-authority-session'
            : request.actorSessionId
    });
}

function decodePreparedGroupMutationIdentity(value: JsonWireValue): JsonWireObject {
    const identity = requireJsonWireObject(value, 'Prepared group mutation AppInbox command');
    requireExactKeys(
        identity,
        ['commandId'],
        'Prepared group mutation AppInbox command'
    );
    requireString(identity.commandId, 'Prepared group mutation command id');
    return identity;
}

function decodeGroupScope(
    value: JsonWireValue | undefined,
    type: AuthenticatedGroupMutationInboxType
): void {
    const scope = requireJsonWireObject(value, `Group ${type} scope`);
    requireExactKeys(scope, ['applicationId', 'workspaceId'], `Group ${type} scope`);
    requireString(scope.applicationId, `Group ${type} application id`);
    requireString(scope.workspaceId, `Group ${type} workspace id`);
}

function isAuthenticatedGroupMutationType(
    type: AppInboxType
): type is AuthenticatedGroupMutationInboxType {
    return type.startsWith('GROUP_') &&
        type !== AppInboxType.GROUP_PRESENCE_EXPIRE &&
        type !== AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP &&
        type !== AppInboxType.GROUP_FORMATION_AUTOMATION &&
        type !== AppInboxType.GROUP_FORMATION_CRITERION &&
        type !== AppInboxType.GROUP_TOPOLOGY_PUBLICATION;
}

function toGroupMutationOperation(
    type: AuthenticatedGroupMutationInboxType
): GroupMutationCommand['operation'] {
    switch (type) {
        case AppInboxType.GROUP_CREATE:
            return 'createGroup';
        case AppInboxType.GROUP_UPDATE:
            return 'updateGroup';
        case AppInboxType.GROUP_DIRECTOR_APPOINT:
            return 'appointDirector';
        case AppInboxType.GROUP_TRANSPORT_PAUSE:
            return 'pauseGroupTransport';
        case AppInboxType.GROUP_TRANSPORT_RESUME:
            return 'resumeGroupTransport';
        case AppInboxType.GROUP_FORMATION_START:
            return 'startGroupFormation';
        case AppInboxType.GROUP_FORMATION_RESET:
            return 'resetGroupFormation';
        case AppInboxType.GROUP_PLAN:
            return 'planGroupLayout';
        case AppInboxType.GROUP_CONNECT:
            return 'connectGroup';
        case AppInboxType.GROUP_ACTIVATE:
            return 'activateGroup';
        case AppInboxType.GROUP_RECONFIGURE:
            return 'reconfigureGroup';
        case AppInboxType.GROUP_JOIN:
            return 'joinGroup';
        case AppInboxType.GROUP_INVITE_CREATE:
            return 'createGroupInvite';
        case AppInboxType.GROUP_INVITE_REVOKE:
            return 'revokeGroupInvite';
        case AppInboxType.GROUP_INVITE_ACCEPT:
            return 'acceptGroupInvite';
        case AppInboxType.GROUP_ADMISSION_GRANT:
            return 'grantGroupAdmission';
        case AppInboxType.GROUP_ADMISSION_DECLINE:
            return 'declineGroupAdmission';
        case AppInboxType.GROUP_JOIN_CODE_ROTATE:
            return 'rotateGroupJoinCode';
        case AppInboxType.GROUP_MEMBER_REMOVE:
            return 'removeGroupMember';
        case AppInboxType.GROUP_MEMBER_BAN:
            return 'banGroupMember';
        case AppInboxType.GROUP_MEMBER_UNBAN:
            return 'unbanGroupMember';
        case AppInboxType.GROUP_MEMBER_ROLE_SET:
            return 'setGroupMemberRole';
        case AppInboxType.GROUP_OWNERSHIP_TRANSFER:
            return 'transferGroupOwnership';
        case AppInboxType.GROUP_MEMBER_UPSERT:
            return 'upsertMember';
        case AppInboxType.GROUP_PRESENCE_CONNECT:
            return 'connectPresence';
        case AppInboxType.GROUP_PRESENCE_HEARTBEAT:
            return 'heartbeatPresence';
        case AppInboxType.GROUP_PRESENCE_DISCONNECT:
            return 'disconnectPresence';
    }
}

function requireJsonWireObject(
    value: JsonWireValue | undefined,
    label: string
): JsonWireObject {
    if (
        value === null || value === undefined || typeof value !== 'object' ||
        isJsonWireArray(value)
    ) {
        throw new TypeError(`${label} must be an exact object`);
    }
    return value;
}

function isJsonWireArray(value: JsonWireValue): value is readonly JsonWireValue[] {
    return Array.isArray(value);
}
