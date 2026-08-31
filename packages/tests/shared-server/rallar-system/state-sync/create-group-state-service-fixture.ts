import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type { GroupStateService } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { InMemoryGroupStateEventStore } from '@shared-server/rallar-system/state-events/in-memory-group-state-event-store.ts';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';

export function createGroupStateServiceFixture(): GroupStateService {
    const runtimeRepository = new FakeRuntimeStateRepository();
    return createGroupStateService({
        runtimeRepository,
        authSessionRepository: new AuthSessionRepository(runtimeRepository),
        groupStateEventStore: new InMemoryGroupStateEventStore(),
        serviceId: 'group-state-fixture',
        readPlannedLayoutRow: async () => null,
        readAcceptedLayoutRow: async () => null
    });
}
