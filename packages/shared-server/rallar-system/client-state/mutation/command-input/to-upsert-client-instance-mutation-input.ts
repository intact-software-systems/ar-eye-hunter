import type { UpsertClientInstanceRequest } from '@shared/api/state-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import type { ClientMutationCommandInput } from '../client-mutation-contracts.ts';
import { toClientMutationActorInput } from './to-client-mutation-actor-input.ts';

export interface ToUpsertClientInstanceMutationInput {
    readonly scope: StateScope;
    readonly principalId: string;
    readonly clientInstanceId: string;
    readonly request: UpsertClientInstanceRequest;
    readonly defaultCommandId: string;
}

export function toUpsertClientInstanceMutationInput(
    commandInput: ToUpsertClientInstanceMutationInput
): ClientMutationCommandInput {
    const commandId = commandInput.request.requestId ?? commandInput.defaultCommandId;
    return {
        operation: 'upsertInstance',
        aggregateRef: { ...commandInput.scope, principalId: commandInput.principalId },
        clientInstanceId: commandInput.clientInstanceId,
        commandId,
        requestId: commandInput.request.requestId ?? null,
        input: {
            status: commandInput.request.status ?? null,
            platform: commandInput.request.platform ?? null,
            deviceLabel: commandInput.request.deviceLabel ?? null,
            appVersion: commandInput.request.appVersion ?? null,
            userAgent: commandInput.request.userAgent ?? null,
            capabilities: commandInput.request.capabilities ? [...commandInput.request.capabilities] : null,
            ...toClientMutationActorInput(commandInput.request)
        }
    };
}
