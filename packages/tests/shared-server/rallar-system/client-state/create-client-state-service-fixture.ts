import type { ClientStateService } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import { InMemoryClientStateEventStore } from '@shared-server/rallar-system/state-events/in-memory-client-state-event-store.ts';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';

export function createClientStateServiceFixture(): ClientStateService {
    return createClientStateService({
        runtimeRepository: new FakeRuntimeStateRepository(),
        clientStateEventStore: new InMemoryClientStateEventStore(),
        serviceId: 'client-state-fixture'
    });
}
