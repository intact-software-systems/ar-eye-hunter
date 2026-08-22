import type { ClientStateRepository } from '@shared-server/mod.ts';

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
