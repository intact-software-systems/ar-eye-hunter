import type { UpsertClientPrincipalRequest } from '@shared/api/state-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '../../../protocol/json-wire-identity.ts';
import { ClientMutationRejectedError } from '../../validation/client-mutation-rejection.ts';
import type { ClientMutationCommandInput } from '../client-mutation-contracts.ts';
import { toClientMutationActorInput } from './to-client-mutation-actor-input.ts';

export interface ToUpsertClientPrincipalMutationInput {
    readonly scope: StateScope;
    readonly principalId: string;
    readonly request: UpsertClientPrincipalRequest;
    readonly defaultCommandId: string;
}

export function toUpsertClientPrincipalMutationInput(
    commandInput: ToUpsertClientPrincipalMutationInput
): ClientMutationCommandInput {
    const commandId = commandInput.request.requestId ?? commandInput.defaultCommandId;
    return {
        operation: 'upsertPrincipal',
        aggregateRef: { ...commandInput.scope, principalId: commandInput.principalId },
        commandId,
        requestId: commandInput.request.requestId ?? null,
        input: {
            username: commandInput.request.username,
            displayName: commandInput.request.displayName ?? null,
            avatarUrl: commandInput.request.avatarUrl ?? null,
            status: commandInput.request.status ?? null,
            authProvider: commandInput.request.authProvider ?? null,
            externalSubjectId: commandInput.request.externalSubjectId ?? null,
            roles: commandInput.request.roles ? [...commandInput.request.roles] : null,
            metadata: decodeClientPrincipalMetadata(commandInput.request.metadata),
            lastSeenAtEpochMs: commandInput.request.lastSeenAtEpochMs ?? null,
            ...toClientMutationActorInput(commandInput.request)
        }
    };
}

function decodeClientPrincipalMetadata(
    metadata: UpsertClientPrincipalRequest['metadata']
): JsonWireObject | null {
    if (metadata === undefined) {
        return null;
    }
    try {
        const value = decodeJsonWireValue(
            structuredClone(metadata),
            'Client principal metadata'
        );
        if (isJsonWireObject(value)) {
            return value;
        }
    }
    catch (error) {
        throw new ClientMutationRejectedError(
            error instanceof Error ? error.message : 'Client principal metadata is invalid'
        );
    }
    throw new ClientMutationRejectedError('Client principal metadata must be a plain object');
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
