import type { HeartbeatClientSessionRequest, StateScope } from '@shared/api/state-types.ts';

import { ClientMutationRejectedError } from '../../validation/client-mutation-rejection.ts';
import type { ClientMutationCommandInput } from '../client-mutation-contracts.ts';
import { toClientMutationActorInput } from './to-client-mutation-actor-input.ts';

export interface ToHeartbeatClientSessionMutationInput {
    readonly scope: StateScope;
    readonly principalId: string;
    readonly clientInstanceId: string;
    readonly sessionId: string;
    readonly request: HeartbeatClientSessionRequest;
    readonly defaultCommandId: string;
}

export function toHeartbeatClientSessionMutationInput(
    commandInput: ToHeartbeatClientSessionMutationInput
): ClientMutationCommandInput {
    if (!commandInput.request.generationId) {
        throw new ClientMutationRejectedError('Heartbeat generation id is required');
    }
    const commandId = commandInput.request.requestId ?? commandInput.defaultCommandId;
    return {
        operation: 'heartbeatSession',
        aggregateRef: { ...commandInput.scope, principalId: commandInput.principalId },
        clientInstanceId: commandInput.clientInstanceId,
        sessionId: commandInput.sessionId,
        commandId,
        requestId: commandInput.request.requestId ?? null,
        input: {
            generationId: commandInput.request.generationId,
            presenceState: commandInput.request.presenceState ?? null,
            lastHeartbeatAtEpochMs: commandInput.request.lastHeartbeatAtEpochMs ?? null,
            expiresAtEpochMs: commandInput.request.expiresAtEpochMs ?? null,
            ...toClientMutationActorInput(commandInput.request)
        }
    };
}
