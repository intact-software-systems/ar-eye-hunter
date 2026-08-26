import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

type RepositoryAlias = ClientStateRepository;

export function mutateLocalAlias(repository: RepositoryAlias): void {
    void repository.insertPrincipal({} as never);
}
