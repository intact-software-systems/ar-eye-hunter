import { toAuthAppInboxType } from '../auth/inbox/auth-app-inbox-routing.ts';
import { decodeAuthMutationIntent } from '../auth/mutation/decode-auth-mutation-intent.ts';
import { decodeCrdtMutationCommand } from '../crdt/mutation/crdt-mutation-command-codec.ts';
import { toDescriptorCommand } from '../group-state/group-mutation-authority.ts';
import type { GroupMutationDescriptor } from '../group-state/group-state-service-contracts.ts';
import { validateGroupMutationCommand } from '../group-state/mutation/command-validation/validate-group-mutation-command.ts';
import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '../protocol/json-wire-identity.ts';
import { readRtcRttAppInboxCommand } from '../rtc-rtt/inbox/rtc-rtt-app-inbox-authority.ts';
import {
    readDurableTopologyAppInboxCommand,
    toTopologyAppInboxType
} from '../topology/inbox/topology-app-inbox-command.ts';
import { AppInboxType, type AppInboxEnqueueInput } from './app-inbox-contracts.ts';

export interface LogicalAppInboxCommand {
    readonly type: AppInboxType;
    readonly authority: JsonWireValue;
    readonly data: JsonWireValue;
}

export function toLogicalAppInboxCommand(
    enqueue: AppInboxEnqueueInput<JsonWireValue, JsonWireValue>
): JsonWireValue {
    const stableAuth = toStableAuthCommand(enqueue.type, enqueue.data);
    if (stableAuth) {
        return encodeLogicalCommand({ type: enqueue.type, authority: null, data: stableAuth });
    }
    const stableGroup = toStableGroupCommand(enqueue.type, enqueue.authority);
    if (stableGroup) {
        return encodeLogicalCommand({ type: enqueue.type, authority: null, data: stableGroup });
    }
    const stableDomainCommand = toStableDomainCommand(enqueue.type, enqueue.data);
    if (stableDomainCommand) {
        return encodeLogicalCommand({ type: enqueue.type, authority: null, data: stableDomainCommand });
    }
    return encodeLogicalCommand({
        type: enqueue.type,
        authority: enqueue.authority === undefined
            ? null
            : decodeJsonWireValue(enqueue.authority, 'AppInbox logical authority'),
        data: enqueue.data
    });
}

function encodeLogicalCommand(command: LogicalAppInboxCommand): JsonWireValue {
    return decodeJsonWireValue(command, 'Logical AppInbox command');
}

function toStableGroupCommand(
    type: AppInboxType,
    authority: JsonWireValue | undefined
): JsonWireValue | undefined {
    const expectedOperation = toGroupAppInboxOperation(type);
    if (!expectedOperation) {
        return undefined;
    }
    const authorized = requireLogicalJsonObject(authority, 'Logical group AppInbox authority');
    const descriptor = requireLogicalJsonObject(
        authorized.descriptor,
        'Logical group AppInbox descriptor'
    ) as GroupMutationDescriptor;
    const command = toDescriptorCommand(descriptor, () => {
        throw new TypeError('Authenticated group mutation requestId is required');
    });
    validateGroupMutationCommand(command);
    if (command.operation !== expectedOperation) {
        throw new TypeError('Group mutation operation differs from AppInbox type');
    }
    return decodeJsonWireValue({
        ...command,
        input: { ...command.input, actorSessionId: null }
    }, 'Logical group AppInbox command');
}

const GROUP_APP_INBOX_OPERATIONS = new Map<AppInboxType, GroupMutationDescriptor['operation']>([
    [AppInboxType.GROUP_CREATE, 'createGroup'],
    [AppInboxType.GROUP_UPDATE, 'updateGroup'],
    [AppInboxType.GROUP_DIRECTOR_APPOINT, 'appointDirector'],
    [AppInboxType.GROUP_ESTABLISHMENT_START, 'startGroupEstablishment'],
    [AppInboxType.GROUP_ACTIVATE, 'activateGroup'],
    [AppInboxType.GROUP_ESTABLISHMENT_REOPEN, 'reopenGroupEstablishment'],
    [AppInboxType.GROUP_JOIN, 'joinGroup'],
    [AppInboxType.GROUP_INVITE_CREATE, 'createGroupInvite'],
    [AppInboxType.GROUP_INVITE_REVOKE, 'revokeGroupInvite'],
    [AppInboxType.GROUP_INVITE_ACCEPT, 'acceptGroupInvite'],
    [AppInboxType.GROUP_JOIN_CODE_ROTATE, 'rotateGroupJoinCode'],
    [AppInboxType.GROUP_ADMISSION_GRANT, 'grantGroupAdmission'],
    [AppInboxType.GROUP_ADMISSION_DECLINE, 'declineGroupAdmission'],
    [AppInboxType.GROUP_MEMBER_REMOVE, 'removeGroupMember'],
    [AppInboxType.GROUP_MEMBER_BAN, 'banGroupMember'],
    [AppInboxType.GROUP_MEMBER_UNBAN, 'unbanGroupMember'],
    [AppInboxType.GROUP_MEMBER_ROLE_SET, 'setGroupMemberRole'],
    [AppInboxType.GROUP_OWNERSHIP_TRANSFER, 'transferGroupOwnership'],
    [AppInboxType.GROUP_MEMBER_UPSERT, 'upsertMember'],
    [AppInboxType.GROUP_PRESENCE_CONNECT, 'connectPresence'],
    [AppInboxType.GROUP_PRESENCE_HEARTBEAT, 'heartbeatPresence'],
    [AppInboxType.GROUP_PRESENCE_DISCONNECT, 'disconnectPresence']
]);

export function toGroupAppInboxOperation(
    type: AppInboxType
): GroupMutationDescriptor['operation'] | undefined {
    return GROUP_APP_INBOX_OPERATIONS.get(type);
}

function toStableAuthCommand(type: AppInboxType, value: JsonWireValue): JsonWireValue | undefined {
    if (!type.startsWith('AUTH_')) {
        return undefined;
    }
    try {
        const intent = decodeAuthMutationIntent(value);
        if (toAuthAppInboxType(intent) !== type) {
            return undefined;
        }
        switch (intent.kind) {
            case 'register-user':
                return {
                    kind: intent.kind,
                    requestId: intent.requestId,
                    registration: {
                        username: intent.registration.username,
                        normalizedUsername: intent.registration.normalizedUsername,
                        displayName: intent.registration.displayName,
                        passwordAlgorithm: intent.registration.passwordAlgorithm,
                        passwordIterations: intent.registration.passwordIterations,
                        roles: intent.registration.roles,
                        status: intent.registration.status
                    }
                };
            case 'issue-session':
                return {
                    kind: intent.kind,
                    requestId: intent.requestId,
                    authority: intent.authority,
                    clientId: intent.clientId,
                    username: intent.username,
                    ttlMs: intent.ttlMs
                };
            case 'logout-session':
                return { kind: intent.kind, requestId: intent.requestId, expected: intent.expected };
            case 'issue-ws-ticket':
                return {
                    kind: intent.kind,
                    requestId: intent.requestId,
                    authority: intent.authority,
                    ttlMs: intent.ttlMs
                };
            case 'consume-ws-ticket':
                return {
                    kind: intent.kind,
                    requestId: intent.requestId,
                    ticketDigest: intent.ticketDigest,
                    expectedSessionId: intent.expectedSessionId
                };
            case 'issue-agent-tickets':
                return {
                    kind: intent.kind,
                    requestId: intent.requestId,
                    authority: intent.authority,
                    ticketTtlMs: intent.ticketTtlMs,
                    agentIds: intent.agentIds
                };
            case 'consume-agent-ticket':
                return {
                    kind: intent.kind,
                    requestId: intent.requestId,
                    ticketDigest: intent.ticketDigest
                };
        }
    }
    catch {
        return undefined;
    }
}

function toStableDomainCommand(type: AppInboxType, value: JsonWireValue): JsonWireValue | undefined {
    try {
        if (type === AppInboxType.CRDT_UPDATE_APPEND) {
            const command = decodeCrdtMutationCommand(value);
            if (command.operation !== 'append') {
                throw new TypeError('CRDT append AppInbox operation is invalid');
            }
            return decodeJsonWireValue({
                operation: command.operation,
                commandId: command.commandId,
                document: command.document,
                documentKey: command.documentKey,
                update: command.update,
                authorizationScope: command.authorizationScope,
                actor: {
                    actorId: command.actor.actorId,
                    principalId: command.actor.principalId
                }
            }, 'Logical CRDT AppInbox command');
        }
        if (type === AppInboxType.RTC_RTT_SUBMIT) {
            const command = readRtcRttAppInboxCommand(value);
            return decodeJsonWireValue({
                actor: command.actor,
                requestId: command.requestId,
                commandHash: command.commandHash,
                mutationCommandHash: command.mutationCommandHash,
                rtt: command.rtt
            }, 'Logical RTC RTT AppInbox command');
        }
        if (!TOPOLOGY_APP_INBOX_TYPES.has(type)) {
            return undefined;
        }
        const command = readDurableTopologyAppInboxCommand(value);
        if (toTopologyAppInboxType(command.operation) !== type) {
            throw new TypeError('Topology operation differs from AppInbox type');
        }
        return decodeJsonWireValue({
            actor: { principalId: command.actor.principalId },
            groupRef: command.groupRef,
            requestId: command.requestId,
            operation: command.operation,
            payload: command.payload
        }, 'Logical topology AppInbox command');
    }
    catch {
        return undefined;
    }
}

const TOPOLOGY_APP_INBOX_TYPES = new Set<AppInboxType>([
    AppInboxType.TOPOLOGY_CONFIG_PUT,
    AppInboxType.TOPOLOGY_CONFIG_DELETE,
    AppInboxType.TOPOLOGY_OVERRIDE_PUT,
    AppInboxType.TOPOLOGY_OVERRIDE_DELETE,
    AppInboxType.TOPOLOGY_RECONFIGURE
]);

function requireLogicalJsonObject(
    value: JsonWireValue | undefined,
    label: string
): JsonWireObject {
    if (value === undefined || value === null || typeof value !== 'object' || isJsonWireArray(value)) {
        throw new TypeError(`${label} must be an exact object`);
    }
    return value;
}

function isJsonWireArray(value: JsonWireValue): value is readonly JsonWireValue[] {
    return Array.isArray(value);
}
