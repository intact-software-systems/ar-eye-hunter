import type { ClientPlatform } from '@shared/api/client-types.ts';
import type { ConnectClientSessionRequest, StateScope } from '@shared/api/state-types.ts';

import { ClientMutationRejectedError } from '../../validation/client-mutation-rejection.ts';
import type { ClientMutationCommandInput } from '../client-mutation-contracts.ts';
import { toClientMutationActorInput } from './to-client-mutation-actor-input.ts';

export interface ClientSessionIdentityDefaults {
    readonly platform?: ClientPlatform;
    readonly userAgent?: string;
    readonly capabilities?: readonly string[];
    readonly principalUsername?: string;
    readonly principalDisplayName?: string;
    readonly principalRoles?: readonly string[];
}

export interface ToConnectClientSessionMutationInput {
    readonly operation: 'connectSession' | 'connectAuthorisedWsSession';
    readonly scope: StateScope;
    readonly principalId: string;
    readonly clientInstanceId: string;
    readonly sessionId: string;
    readonly request: ConnectClientSessionRequest;
    readonly defaultCommandId: string;
    readonly identityDefaults: ClientSessionIdentityDefaults;
}

export function toConnectClientSessionMutationInput(
    commandInput: ToConnectClientSessionMutationInput
): ClientMutationCommandInput {
    if (!commandInput.request.generationId) {
        throw new ClientMutationRejectedError('Connection generation id is required');
    }
    const commandId = commandInput.request.requestId ?? commandInput.defaultCommandId;
    return {
        operation: commandInput.operation,
        aggregateRef: { ...commandInput.scope, principalId: commandInput.principalId },
        clientInstanceId: commandInput.clientInstanceId,
        sessionId: commandInput.sessionId,
        commandId,
        requestId: commandInput.request.requestId ?? null,
        input: {
            generationId: commandInput.request.generationId,
            presenceState: commandInput.request.presenceState ?? null,
            transport: commandInput.request.transport ?? null,
            connectionId: commandInput.request.connectionId ?? null,
            authenticatedAtEpochMs: commandInput.request.authenticatedAtEpochMs ?? null,
            connectedAtEpochMs: commandInput.request.connectedAtEpochMs ?? null,
            lastHeartbeatAtEpochMs: commandInput.request.lastHeartbeatAtEpochMs ?? null,
            expiresAtEpochMs: commandInput.request.expiresAtEpochMs ?? null,
            instancePlatform: commandInput.identityDefaults.platform ?? null,
            instanceUserAgent: commandInput.identityDefaults.userAgent ?? null,
            instanceCapabilities: commandInput.identityDefaults.capabilities
                ? [...commandInput.identityDefaults.capabilities]
                : null,
            principalUsername: commandInput.identityDefaults.principalUsername ?? null,
            principalDisplayName: commandInput.identityDefaults.principalDisplayName ?? null,
            principalRoles: commandInput.identityDefaults.principalRoles
                ? [...commandInput.identityDefaults.principalRoles]
                : null,
            ...toClientMutationActorInput(commandInput.request)
        }
    };
}
