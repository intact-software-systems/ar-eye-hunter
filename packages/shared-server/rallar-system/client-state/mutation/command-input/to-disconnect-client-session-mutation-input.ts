import type { DisconnectClientSessionRequest, StateScope } from '@shared/api/state-types.ts';

import { ClientMutationRejectedError } from '../../validation/client-mutation-rejection.ts';
import type { ClientMutationCommandInput } from '../client-mutation-contracts.ts';
import { toClientMutationActorInput } from './to-client-mutation-actor-input.ts';

export interface ToDisconnectClientSessionMutationInput {
    readonly operation: 'disconnectSession' | 'disconnectAuthorisedWsSession';
    readonly scope: StateScope;
    readonly principalId: string;
    readonly clientInstanceId: string;
    readonly sessionId: string;
    readonly request: DisconnectClientSessionRequest;
    readonly defaultCommandId: string;
}

export function toDisconnectClientSessionMutationInput(
    commandInput: ToDisconnectClientSessionMutationInput
): ClientMutationCommandInput {
    if (!commandInput.request.generationId) {
        throw new ClientMutationRejectedError('Disconnect generation id is required');
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
            disconnectedAtEpochMs: commandInput.request.disconnectedAtEpochMs ?? null,
            lastHeartbeatAtEpochMs: commandInput.request.lastHeartbeatAtEpochMs ?? null,
            expiresAtEpochMs: commandInput.request.expiresAtEpochMs ?? null,
            ...toClientMutationActorInput(commandInput.request)
        }
    };
}
