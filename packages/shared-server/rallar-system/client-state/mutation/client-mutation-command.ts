import type { ClientPlatform } from '@shared/api/client-types.ts';
import type {
    ConnectClientSessionRequest,
    DisconnectClientSessionRequest,
    HeartbeatClientSessionRequest,
    StateScope,
    UpsertClientInstanceRequest,
    UpsertClientPrincipalRequest
} from '@shared/api/state-types.ts';
import type { ClientSessionExpiryCandidate } from '../../repositories/session-expiry.ts';
import { hashMutationCommand, type JsonWireValue } from '../../services/mutation-command-identity.ts';
import { ClientMutationRejectedError } from '../client-state-validation-primitives.ts';

import type {
    ClientMutationAuthority,
    ClientMutationCommand,
    ClientMutationCommandInput,
    ClientMutationFacts
} from './client-mutation-contracts.ts';
import { validateClientMutationCommand } from './command-validation/validate-client-mutation-command.ts';

export type ClientMutationPersistedFacts = Omit<ClientMutationFacts, 'commandHash'>;

type ClientExpiryCommandInput = Extract<ClientMutationCommandInput, { operation: 'expireSession'; }>;

interface ClientMutationActorInput {
    readonly actorPrincipalId: string | null;
    readonly actorSessionId: string | null;
    readonly reason: string | null;
    readonly traceId: string | null;
}

export async function toClientMutationCommand(
    input: ClientMutationCommandInput,
    facts: ClientMutationPersistedFacts,
    authority: ClientMutationAuthority
): Promise<ClientMutationCommand> {
    const command = {
        ...input,
        authority,
        facts: {
            ...facts,
            commandHash: await hashMutationCommand({ ...input, authority } as JsonWireValue)
        }
    } as ClientMutationCommand;
    validateClientMutationCommand(command);
    return command;
}

export function toUpsertPrincipalCommandInput(
    scope: StateScope,
    principalId: string,
    request: UpsertClientPrincipalRequest,
    fallbackCommandId: string
): ClientMutationCommandInput {
    const commandId = request.requestId ?? fallbackCommandId;
    return {
        operation: 'upsertPrincipal',
        aggregateRef: { ...scope, principalId },
        commandId,
        requestId: request.requestId ?? null,
        input: {
            username: request.username,
            displayName: request.displayName ?? null,
            avatarUrl: request.avatarUrl ?? null,
            status: request.status ?? null,
            authProvider: request.authProvider ?? null,
            externalSubjectId: request.externalSubjectId ?? null,
            roles: request.roles ? [...request.roles] : null,
            metadata: request.metadata ? structuredClone(request.metadata) : null,
            lastSeenAtEpochMs: request.lastSeenAtEpochMs ?? null,
            ...toActorInput(request)
        }
    };
}

export function toUpsertInstanceCommandInput(
    scope: StateScope,
    principalId: string,
    clientInstanceId: string,
    request: UpsertClientInstanceRequest,
    fallbackCommandId: string
): ClientMutationCommandInput {
    const commandId = request.requestId ?? fallbackCommandId;
    return {
        operation: 'upsertInstance',
        aggregateRef: { ...scope, principalId },
        clientInstanceId,
        commandId,
        requestId: request.requestId ?? null,
        input: {
            status: request.status ?? null,
            platform: request.platform ?? null,
            deviceLabel: request.deviceLabel ?? null,
            appVersion: request.appVersion ?? null,
            userAgent: request.userAgent ?? null,
            capabilities: request.capabilities ? [...request.capabilities] : null,
            ...toActorInput(request)
        }
    };
}

export function toConnectCommandInput(
    operation: 'connectSession' | 'connectAuthorisedWsSession',
    scope: StateScope,
    principalId: string,
    clientInstanceId: string,
    sessionId: string,
    request: ConnectClientSessionRequest,
    fallbackCommandId: string,
    instance: Readonly<{
        platform?: ClientPlatform;
        userAgent?: string;
        capabilities?: readonly string[];
        principalUsername?: string;
        principalDisplayName?: string;
        principalRoles?: readonly string[];
    }>
): ClientMutationCommandInput {
    if (!request.generationId) {
        throw new ClientMutationRejectedError('Connection generation id is required');
    }
    const commandId = request.requestId ?? fallbackCommandId;
    return {
        operation,
        aggregateRef: { ...scope, principalId },
        clientInstanceId,
        sessionId,
        commandId,
        requestId: request.requestId ?? null,
        input: {
            generationId: request.generationId,
            presenceState: request.presenceState ?? null,
            transport: request.transport ?? null,
            connectionId: request.connectionId ?? null,
            authenticatedAtEpochMs: request.authenticatedAtEpochMs ?? null,
            connectedAtEpochMs: request.connectedAtEpochMs ?? null,
            lastHeartbeatAtEpochMs: request.lastHeartbeatAtEpochMs ?? null,
            expiresAtEpochMs: request.expiresAtEpochMs ?? null,
            instancePlatform: instance.platform ?? null,
            instanceUserAgent: instance.userAgent ?? null,
            instanceCapabilities: instance.capabilities ? [...instance.capabilities] : null,
            principalUsername: instance.principalUsername ?? null,
            principalDisplayName: instance.principalDisplayName ?? null,
            principalRoles: instance.principalRoles ? [...instance.principalRoles] : null,
            ...toActorInput(request)
        }
    };
}

export function toHeartbeatCommandInput(
    scope: StateScope,
    principalId: string,
    clientInstanceId: string,
    sessionId: string,
    request: HeartbeatClientSessionRequest,
    fallbackCommandId: string
): ClientMutationCommandInput {
    if (!request.generationId) {
        throw new ClientMutationRejectedError('Heartbeat generation id is required');
    }
    const commandId = request.requestId ?? fallbackCommandId;
    return {
        operation: 'heartbeatSession',
        aggregateRef: { ...scope, principalId },
        clientInstanceId,
        sessionId,
        commandId,
        requestId: request.requestId ?? null,
        input: {
            generationId: request.generationId,
            presenceState: request.presenceState ?? null,
            lastHeartbeatAtEpochMs: request.lastHeartbeatAtEpochMs ?? null,
            expiresAtEpochMs: request.expiresAtEpochMs ?? null,
            ...toActorInput(request)
        }
    };
}

export function toDisconnectCommandInput(
    operation: 'disconnectSession' | 'disconnectAuthorisedWsSession',
    scope: StateScope,
    principalId: string,
    clientInstanceId: string,
    sessionId: string,
    request: DisconnectClientSessionRequest,
    fallbackCommandId: string
): ClientMutationCommandInput {
    if (!request.generationId) {
        throw new ClientMutationRejectedError('Disconnect generation id is required');
    }
    const commandId = request.requestId ?? fallbackCommandId;
    return {
        operation,
        aggregateRef: { ...scope, principalId },
        clientInstanceId,
        sessionId,
        commandId,
        requestId: request.requestId ?? null,
        input: {
            generationId: request.generationId,
            disconnectedAtEpochMs: request.disconnectedAtEpochMs ?? null,
            lastHeartbeatAtEpochMs: request.lastHeartbeatAtEpochMs ?? null,
            expiresAtEpochMs: request.expiresAtEpochMs ?? null,
            ...toActorInput(request)
        }
    };
}

export function toExpiryCommandInput(
    session: ClientSessionExpiryCandidate
): ClientExpiryCommandInput {
    const commandId = [
        'expire-client-session',
        session.sessionId,
        session.generationId,
        session.generationVersion,
        session.observedExpiresAtEpochMs
    ].join(':');
    return {
        operation: 'expireSession',
        aggregateRef: {
            applicationId: session.applicationId,
            workspaceId: session.workspaceId,
            principalId: session.principalId
        },
        clientInstanceId: session.clientInstanceId,
        sessionId: session.sessionId,
        commandId,
        requestId: commandId,
        input: {
            generationId: session.generationId,
            generationVersion: session.generationVersion,
            observedExpiresAtEpochMs: session.observedExpiresAtEpochMs,
            expiresAtEpochMs: session.observedExpiresAtEpochMs,
            actorPrincipalId: session.principalId,
            actorSessionId: session.sessionId,
            reason: 'expired',
            traceId: null
        }
    };
}

function toActorInput(
    request: Readonly<{
        actorPrincipalId?: string;
        actorSessionId?: string;
        reason?: string;
        traceId?: string;
    }>
): ClientMutationActorInput {
    return {
        actorPrincipalId: request.actorPrincipalId ?? null,
        actorSessionId: request.actorSessionId ?? null,
        reason: request.reason ?? null,
        traceId: request.traceId ?? null
    };
}
