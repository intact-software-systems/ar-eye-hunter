import type { GroupPresenceSession } from '@shared/api/group-types.ts';
import type {
    ConnectGroupPresenceSessionRequest,
    DisconnectGroupPresenceSessionRequest,
    HeartbeatGroupPresenceSessionRequest
} from '@shared/api/state-types.ts';
import { NonRetryableException } from '@shared/queuebox/DequeueResourceEntryController.ts';

import { serializeCanonicalJson } from '../protocol/canonical-json.ts';
import { toGroupMutationActorInput, toGroupMutationIdentity } from './group-mutation-command.ts';
import type { GroupMutationDescriptor } from './group-state-service-contracts.ts';
import type { GroupMutationCommand } from './mutation/group-mutation-contracts.ts';

type GroupPresenceMutationRequest =
    | ConnectGroupPresenceSessionRequest
    | DisconnectGroupPresenceSessionRequest
    | HeartbeatGroupPresenceSessionRequest;

export function toPresenceMutationCommand(
    descriptor: GroupMutationDescriptor,
    randomId: () => string
): GroupMutationCommand {
    const sessionId = requireSessionId(descriptor);
    switch (descriptor.operation) {
        case 'connectPresence':
            return toConnectPresenceCommand(descriptor, sessionId, randomId);
        case 'heartbeatPresence':
            return toHeartbeatPresenceCommand(descriptor, sessionId, randomId);
        case 'disconnectPresence':
            return toDisconnectPresenceCommand(descriptor, sessionId, randomId);
        default:
            throw new TypeError(`Unsupported presence group mutation: ${descriptor.operation}`);
    }
}

function requireSessionId(descriptor: GroupMutationDescriptor): string {
    if (!descriptor.sessionId) {
        throw new NonRetryableException('Group mutation session is required');
    }
    return descriptor.sessionId;
}

function toConnectPresenceCommand(
    descriptor: GroupMutationDescriptor,
    sessionId: string,
    randomId: () => string
): GroupMutationCommand {
    const request = readGroupPresenceMutationRequest(descriptor);
    if (typeof request.principalId !== 'string' || request.principalId.length === 0) {
        throw new NonRetryableException('Group presence principal id is required');
    }
    return {
        operation: 'connectPresence',
        aggregateRef: { ...descriptor.scope, groupId: descriptor.groupId },
        sessionId,
        ...toGroupMutationIdentity(request.requestId, randomId),
        input: {
            principalId: request.principalId,
            generationId: request.generationId,
            connectedAtEpochMs: 'connectedAtEpochMs' in request
                ? (request.connectedAtEpochMs ?? null)
                : null,
            lastHeartbeatAtEpochMs: request.lastHeartbeatAtEpochMs ?? null,
            expiresAtEpochMs: request.expiresAtEpochMs ?? null,
            ...toGroupMutationActorInput(request),
            actorPrincipalId: request.actorPrincipalId ?? request.principalId
        }
    };
}

function toHeartbeatPresenceCommand(
    descriptor: GroupMutationDescriptor,
    sessionId: string,
    randomId: () => string
): GroupMutationCommand {
    const request = readGroupPresenceMutationRequest(descriptor);
    return {
        operation: 'heartbeatPresence',
        aggregateRef: { ...descriptor.scope, groupId: descriptor.groupId },
        sessionId,
        ...toGroupMutationIdentity(request.requestId, randomId),
        input: {
            principalId: request.principalId ?? null,
            generationId: request.generationId,
            lastHeartbeatAtEpochMs: request.lastHeartbeatAtEpochMs ?? null,
            expiresAtEpochMs: request.expiresAtEpochMs ?? null,
            ...toGroupMutationActorInput(request)
        }
    };
}

function toDisconnectPresenceCommand(
    descriptor: GroupMutationDescriptor,
    sessionId: string,
    randomId: () => string
): GroupMutationCommand {
    const request = readGroupPresenceMutationRequest(descriptor);
    return {
        operation: 'disconnectPresence',
        aggregateRef: { ...descriptor.scope, groupId: descriptor.groupId },
        sessionId,
        ...toGroupMutationIdentity(request.requestId, randomId),
        input: {
            principalId: request.principalId ?? null,
            generationId: request.generationId,
            generationVersion: null,
            observedExpiresAtEpochMs: null,
            disconnectedAtEpochMs: 'disconnectedAtEpochMs' in request
                ? (request.disconnectedAtEpochMs ?? null)
                : null,
            lastHeartbeatAtEpochMs: request.lastHeartbeatAtEpochMs ?? null,
            expiresAtEpochMs: request.expiresAtEpochMs ?? null,
            ...toGroupMutationActorInput(request)
        }
    };
}

export function toExpiryCommand(
    session: GroupPresenceSession,
    atEpochMs: number
): GroupMutationCommand {
    const semanticCommand = {
        operation: 'disconnectPresence',
        aggregateRef: {
            applicationId: session.applicationId,
            workspaceId: session.workspaceId,
            groupId: session.groupId
        },
        sessionId: session.sessionId,
        input: {
            principalId: session.principalId,
            generationId: session.generationId,
            generationVersion: session.generationVersion,
            observedExpiresAtEpochMs: session.expiresAtEpochMs,
            disconnectedAtEpochMs: atEpochMs,
            lastHeartbeatAtEpochMs: session.lastHeartbeatAtEpochMs,
            expiresAtEpochMs: session.expiresAtEpochMs,
            actorPrincipalId: null,
            actorSessionId: null,
            reason: 'expired',
            traceId: null
        }
    } as const;
    const commandId = groupStateMaintenanceRequestId('expiry', semanticCommand);
    return { ...semanticCommand, commandId, requestId: commandId };
}

export function toSessionCleanupCommand(
    session: GroupPresenceSession,
    disconnectedAtEpochMs: number
): GroupMutationCommand {
    const semanticCommand = {
        operation: 'disconnectPresence',
        aggregateRef: {
            applicationId: session.applicationId,
            workspaceId: session.workspaceId,
            groupId: session.groupId
        },
        sessionId: session.sessionId,
        input: {
            principalId: session.principalId,
            generationId: session.generationId,
            generationVersion: session.generationVersion,
            observedExpiresAtEpochMs: session.expiresAtEpochMs,
            disconnectedAtEpochMs,
            lastHeartbeatAtEpochMs: null,
            expiresAtEpochMs: null,
            actorPrincipalId: null,
            actorSessionId: null,
            reason: null,
            traceId: null
        }
    } as const;
    const commandId = groupStateMaintenanceRequestId('session-cleanup', semanticCommand);
    return { ...semanticCommand, commandId, requestId: commandId };
}

export type GroupMaintenanceSemanticCommand = Pick<
    Extract<GroupMutationCommand, { operation: 'disconnectPresence'; }>,
    'operation' | 'aggregateRef' | 'sessionId' | 'input'
>;

export function groupStateMaintenanceRequestId(
    authority: 'expiry' | 'session-cleanup',
    semanticCommand: GroupMaintenanceSemanticCommand
): string {
    const domain = authority === 'expiry' ? 'expire-group-presence' : 'cleanup-group-presence-session';
    return `${domain}:v1:${serializeCanonicalJson(semanticCommand)}`;
}

function readGroupPresenceMutationRequest(
    descriptor: GroupMutationDescriptor
): GroupPresenceMutationRequest {
    const request = descriptor.request;
    if (
        !('generationId' in request) ||
        typeof request.generationId !== 'string' ||
        request.generationId.length === 0
    ) {
        throw new NonRetryableException('Group presence generation id is required');
    }
    return request;
}
