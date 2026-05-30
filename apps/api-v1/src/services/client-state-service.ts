import {
    type ClientMutationWritten,
    type ClientStateService,
    type ClientStateServiceDependencies,
    type ClientStateWritten,
    createClientStateService,
    type RegisterAuthorisedWsClientInput,
} from '@shared-server/rallar-system/services/client-state-service.ts';
import { myServerId } from '../runtime/runtime-identity.ts';
import { createAuthSessionRepository, createRuntimeStateRepository, } from '../repository/createStateRepositories.ts';
import { getWsStateSyncPublisher } from './state-sync-service.ts';
import { getApiTimingSink } from './timing-service.ts';

export {
    type ClientMutationWritten,
    type ClientStateService,
    type ClientStateServiceDependencies,
    type ClientStateWritten,
    createClientStateService,
    type RegisterAuthorisedWsClientInput,
};

export function getClientStateService(): ClientStateService {
    const runtimeRepository = createRuntimeStateRepository();

    return createClientStateService({
        runtimeRepository,
        syncPublisher: getWsStateSyncPublisher(),
        authSessionRepository: createAuthSessionRepository(runtimeRepository),
        serviceId: myServerId,
        timing: getApiTimingSink(),
    });
}
