import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function mutateLocalFactoryAlias(): void {
    const alias = createRepository;
    const repository = alias();
    void repository.insertPrincipal({} as never);
}

function createRepository(): ClientStateRepository {
    throw new Error('analysis fixture');
}
