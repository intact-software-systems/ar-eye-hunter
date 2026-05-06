import {
    type ClientStateService,
    type ClientStateServiceDependencies,
    createClientStateService,
    type RegisterAuthorisedWsClientInput,
} from '@shared-server/rallar-system/services/client-state-service.ts';
import { myServerId } from '../runtime/runtime-identity.ts';
import { createAuthSessionRepository, createRuntimeStateRepository, } from '../repository/createStateRepositories.ts';
import { getWsStateSyncPublisher } from './state-sync-service.ts';

export {
    type ClientStateService,
    type ClientStateServiceDependencies,
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
    });
}
