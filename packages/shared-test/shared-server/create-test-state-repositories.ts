import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import type { ClientStateEventStore } from '@shared-server/rallar-system/state-events/client-state-event-store.ts';
import type { GroupStateEventStore } from '@shared-server/rallar-system/state-events/group-state-event-store.ts';
import type { RuntimeStateRepositoryLike } from '@shared-server/runtime-state/runtime-state-repository.ts';

export interface TestClientStateEventStoreOwner {
    readonly clientStateEventStore: ClientStateEventStore;
}

export interface TestGroupStateEventStoreOwner {
    readonly groupStateEventStore: GroupStateEventStore;
}

export function createTestClientStateRepository(
    runtimeRepository: RuntimeStateRepositoryLike & TestClientStateEventStoreOwner
): ClientStateRepository;
export function createTestClientStateRepository(
    runtimeRepository: RuntimeStateRepositoryLike,
    eventStore: ClientStateEventStore
): ClientStateRepository;
export function createTestClientStateRepository(
    runtimeRepository: RuntimeStateRepositoryLike & Partial<TestClientStateEventStoreOwner>,
    eventStore?: ClientStateEventStore
): ClientStateRepository {
    return new ClientStateRepository(
        runtimeRepository,
        requireClientStateEventStore(runtimeRepository, eventStore)
    );
}

export function createTestGroupStateRepository(
    runtimeRepository: RuntimeStateRepositoryLike & TestGroupStateEventStoreOwner
): GroupStateRepository;
export function createTestGroupStateRepository(
    runtimeRepository: RuntimeStateRepositoryLike,
    eventStore: GroupStateEventStore
): GroupStateRepository;
export function createTestGroupStateRepository(
    runtimeRepository: RuntimeStateRepositoryLike & Partial<TestGroupStateEventStoreOwner>,
    eventStore?: GroupStateEventStore
): GroupStateRepository {
    return new GroupStateRepository(
        runtimeRepository,
        requireGroupStateEventStore(runtimeRepository, eventStore)
    );
}

function requireClientStateEventStore(
    runtimeRepository: Partial<TestClientStateEventStoreOwner>,
    eventStore: ClientStateEventStore | undefined
): ClientStateEventStore {
    const selected = eventStore ?? runtimeRepository.clientStateEventStore;
    if (selected === undefined) {
        throw new TypeError('Test client-state repository construction requires an explicit event store owner');
    }
    return selected;
}

function requireGroupStateEventStore(
    runtimeRepository: Partial<TestGroupStateEventStoreOwner>,
    eventStore: GroupStateEventStore | undefined
): GroupStateEventStore {
    const selected = eventStore ?? runtimeRepository.groupStateEventStore;
    if (selected === undefined) {
        throw new TypeError('Test group-state repository construction requires an explicit event store owner');
    }
    return selected;
}
