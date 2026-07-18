import {
  createGroupStateService,
  type GroupStateService,
  type GroupStateServiceDependencies,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import type { CachedGroupStateService } from '@shared-server/rallar-system/services/cached-group-state-service.ts';
import { myServerId } from '../runtime/runtime-identity.ts';
import {
  createGroupStateEventRepository,
  createRuntimeStateRepository,
} from '../repository/createStateRepositories.ts';
import { getWsStateSyncPublisher } from './state-sync-service.ts';
import { getApiTimingSink } from './timing-service.ts';

export { createGroupStateService, type GroupStateService, type GroupStateServiceDependencies };

export type ApiGroupStateService = GroupStateService & Pick<
  CachedGroupStateService,
  'readCurrentSnapshot'
>;

export function getGroupStateService(): ApiGroupStateService {
  const durable = createGroupStateService({
    runtimeRepository: createRuntimeStateRepository(),
    createGroupStateEventStore: createGroupStateEventRepository,
    syncPublisher: getWsStateSyncPublisher(),
    serviceId: myServerId,
    timing: getApiTimingSink(),
  });

  return {
    ...durable,
    readCurrentSnapshot: durable.readSnapshot,
  };
}
