import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function mutateReturnedStoredFactory(): void {
    const selectFactory = () => createRepository;
    const holder = { selectFactory };
    const factory = holder.selectFactory();
    const repository = factory();
    void repository.insertPrincipal({} as never);
}

function createRepository(): ClientStateRepository {
    throw new Error('analysis fixture');
}
