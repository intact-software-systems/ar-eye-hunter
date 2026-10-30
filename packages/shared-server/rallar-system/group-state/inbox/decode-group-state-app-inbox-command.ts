import { requireExactKeys, requireString } from '@shared/api/exact-object-decoding.ts';
import { AppInboxType } from '../../app-inbox/app-inbox-contracts.ts';
import type { JsonWireObject, JsonWireValue } from '../../protocol/json-wire-identity.ts';
import { assertGroupMutationRequest } from '../mutation/command-validation/group-mutation-request-validation.ts';
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
    AppInboxType.GROUP_PUBLICATION_GRANT,
    AppInboxType.GROUP_PUBLICATION_REVOKE,
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
        type === AppInboxType.GROUP_TOPOLOGY_PUBLICATION ||
        type === AppInboxType.GROUP_ACTIVATION_STATUS
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
    assertPersistedGroupMutationRequest(operation, command.request);
    return value;
}

function assertPersistedGroupMutationRequest(
    operation: GroupMutationCommand['operation'],
    value: JsonWireValue | undefined
): void {
    const request = requireJsonWireObject(value, `Group ${operation} request`);
    assertGroupMutationRequest(operation, {
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
        type !== AppInboxType.GROUP_TOPOLOGY_PUBLICATION &&
        type !== AppInboxType.GROUP_ACTIVATION_STATUS;
}

const GROUP_MUTATION_OPERATIONS: Record<AuthenticatedGroupMutationInboxType, GroupMutationCommand['operation']> = {
    [AppInboxType.GROUP_CREATE]: 'createGroup',
    [AppInboxType.GROUP_UPDATE]: 'updateGroup',
    [AppInboxType.GROUP_DIRECTOR_APPOINT]: 'appointDirector',
    [AppInboxType.GROUP_TRANSPORT_PAUSE]: 'pauseGroupTransport',
    [AppInboxType.GROUP_TRANSPORT_RESUME]: 'resumeGroupTransport',
    [AppInboxType.GROUP_FORMATION_START]: 'startGroupFormation',
    [AppInboxType.GROUP_FORMATION_RESET]: 'resetGroupFormation',
    [AppInboxType.GROUP_PLAN]: 'planGroupLayout',
    [AppInboxType.GROUP_CONNECT]: 'connectGroup',
    [AppInboxType.GROUP_ACTIVATE]: 'activateGroup',
    [AppInboxType.GROUP_RECONFIGURE]: 'reconfigureGroup',
    [AppInboxType.GROUP_JOIN]: 'joinGroup',
    [AppInboxType.GROUP_INVITE_CREATE]: 'createGroupInvite',
    [AppInboxType.GROUP_INVITE_REVOKE]: 'revokeGroupInvite',
    [AppInboxType.GROUP_INVITE_ACCEPT]: 'acceptGroupInvite',
    [AppInboxType.GROUP_ADMISSION_GRANT]: 'grantGroupAdmission',
    [AppInboxType.GROUP_ADMISSION_DECLINE]: 'declineGroupAdmission',
    [AppInboxType.GROUP_JOIN_CODE_ROTATE]: 'rotateGroupJoinCode',
    [AppInboxType.GROUP_MEMBER_REMOVE]: 'removeGroupMember',
    [AppInboxType.GROUP_MEMBER_BAN]: 'banGroupMember',
    [AppInboxType.GROUP_MEMBER_UNBAN]: 'unbanGroupMember',
    [AppInboxType.GROUP_MEMBER_ROLE_SET]: 'setGroupMemberRole',
    [AppInboxType.GROUP_PUBLICATION_GRANT]: 'grantGroupPublication',
    [AppInboxType.GROUP_PUBLICATION_REVOKE]: 'revokeGroupPublication',
    [AppInboxType.GROUP_OWNERSHIP_TRANSFER]: 'transferGroupOwnership',
    [AppInboxType.GROUP_MEMBER_UPSERT]: 'upsertMember',
    [AppInboxType.GROUP_PRESENCE_CONNECT]: 'connectPresence',
    [AppInboxType.GROUP_PRESENCE_HEARTBEAT]: 'heartbeatPresence',
    [AppInboxType.GROUP_PRESENCE_DISCONNECT]: 'disconnectPresence'
};

function toGroupMutationOperation(type: AuthenticatedGroupMutationInboxType): GroupMutationCommand['operation'] {
    return GROUP_MUTATION_OPERATIONS[type];
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
