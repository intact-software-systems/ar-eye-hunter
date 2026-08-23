import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import type { ClientStateEventStore } from '@shared-server/rallar-system/state-events/client-state-event-store.ts';
import type { GroupStateEventStore } from '@shared-server/rallar-system/state-events/group-state-event-store.ts';
import { InMemoryClientStateEventStore } from '@shared-server/rallar-system/state-events/in-memory-client-state-event-store.ts';
import { InMemoryGroupStateEventStore } from '@shared-server/rallar-system/state-events/in-memory-group-state-event-store.ts';
import type { RuntimeStateRepositoryLike } from '@shared-server/runtime-state/runtime-state-repository.ts';

export function createTestClientStateRepository(
    runtimeRepository: RuntimeStateRepositoryLike,
    eventStore: ClientStateEventStore = new InMemoryClientStateEventStore()
): ClientStateRepository {
    return new ClientStateRepository(runtimeRepository, eventStore);
}

export function createTestGroupStateRepository(
    runtimeRepository: RuntimeStateRepositoryLike,
    eventStore: GroupStateEventStore = new InMemoryGroupStateEventStore()
): GroupStateRepository {
    return new GroupStateRepository(runtimeRepository, eventStore);
}
