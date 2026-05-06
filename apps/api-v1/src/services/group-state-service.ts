import {
    createGroupStateService,
    type GroupStateService,
    type GroupStateServiceDependencies,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import { myServerId } from '../runtime/runtime-identity.ts';
import { createRuntimeStateRepository } from '../repository/createStateRepositories.ts';
import { getWsStateSyncPublisher } from './state-sync-service.ts';

export { createGroupStateService, type GroupStateService, type GroupStateServiceDependencies };

export function getGroupStateService(): GroupStateService {
    return createGroupStateService({
        runtimeRepository: createRuntimeStateRepository(),
        syncPublisher: getWsStateSyncPublisher(),
        serviceId: myServerId,
    });
}
