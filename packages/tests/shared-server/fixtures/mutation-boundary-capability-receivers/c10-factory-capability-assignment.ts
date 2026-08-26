import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function mutateFactoryCapability(): void {
    let repository: ClientStateRepository | undefined = undefined;
    repository = createRepository();
    void repository.insertPrincipal({} as never);
}

function createRepository(): ClientStateRepository {
    throw new Error('analysis fixture');
}
