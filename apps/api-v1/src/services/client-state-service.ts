import {
  type ClientMutationWritten,
  type ClientStateService,
  type ClientStateServiceDependencies,
  type ClientStateWritten,
  createClientStateService,
  type RegisterAuthorisedWsClientInput,
} from '@shared-server/rallar-system/services/client-state-service.ts';
import { myServerId } from '../runtime/runtime-identity.ts';
import {
  readApiGroupFormationDampingConfig,
} from '../runtime/group-formation/group-formation-damping-config.ts';
import {
  createClientStateEventRepository,
  createRuntimeStateRepository,
} from '../repository/createStateRepositories.ts';
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
    formationDamping: readApiGroupFormationDampingConfig().damping,
    createClientStateEventStore: createClientStateEventRepository,
    serviceId: myServerId,
    timing: getApiTimingSink(),
  });
}
