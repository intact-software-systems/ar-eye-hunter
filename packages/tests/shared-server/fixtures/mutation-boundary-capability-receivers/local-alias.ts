import type { ClientStateRepository } from '@shared-server/mod.ts';

type RepositoryAlias = ClientStateRepository;

export function mutateLocalAlias(repository: RepositoryAlias): void {
    void repository.insertPrincipal({} as never);
}
