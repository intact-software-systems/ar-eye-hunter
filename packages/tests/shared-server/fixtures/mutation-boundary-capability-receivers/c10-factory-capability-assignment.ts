import type { ClientStateRepository } from '@shared-server/mod.ts';

export function mutateFactoryCapability(): void {
    let repository: ClientStateRepository | undefined = undefined;
    repository = createRepository();
    void repository.insertPrincipal({} as never);
}

function createRepository(): ClientStateRepository {
    throw new Error('analysis fixture');
}
