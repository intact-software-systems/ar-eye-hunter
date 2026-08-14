import {
  createGroupStateService,
  type GroupStateService,
  type GroupStateServiceDependencies,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import type { CachedGroupStateService } from '@shared-server/rallar-system/services/cached-group-state-service.ts';
import { myServerId } from '../runtime/runtime-identity.ts';
import {
  createAuthSessionRepository,
  createGroupStateEventRepository,
  createRuntimeStateRepository,
} from '../repository/createStateRepositories.ts';
import { getApiTimingSink } from './timing-service.ts';
import {
  readApiGroupFormationDampingConfig,
} from '../runtime/group-formation/group-formation-damping-config.ts';
import { readApiGroupCapacityConfig } from '../runtime/group-formation/group-capacity-config.ts';

export { createGroupStateService, type GroupStateService, type GroupStateServiceDependencies };

export type ApiGroupStateService =
  & GroupStateService
  & Pick<
    CachedGroupStateService,
    'readCurrentSnapshot'
  >;

export function getGroupStateService(): ApiGroupStateService {
  const runtimeRepository = createRuntimeStateRepository();
  const durable = createGroupStateService({
    runtimeRepository,
    formationDamping: readApiGroupFormationDampingConfig().damping,
    capacity: readApiGroupCapacityConfig(),
    authSessionRepository: createAuthSessionRepository(runtimeRepository),
    createGroupStateEventStore: createGroupStateEventRepository,
    serviceId: myServerId,
    timing: getApiTimingSink(),
  });

  return {
    ...durable,
    readCurrentSnapshot: durable.readSnapshot,
  };
}
